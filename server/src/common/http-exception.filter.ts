import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import type { Response } from 'express'

/**
 * 全局异常过滤器：把所有异常改写为 `{ code, msg, data: null }`，HTTP 状态码保持不变。
 *
 * https://api.sakta.top 与 Blog BFF 都是这个形状，客户端按 `msg` 直接弹提示；
 * Nest 默认的 `{ message, error, statusCode }` 会让上游文案永远透不出来。
 * class-validator 校验失败时 message 是数组，取第一条。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter')

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()

    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let msg = '服务器内部错误'

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'string') {
        msg = body
      } else if (body && typeof body === 'object') {
        const detail = body as { message?: string | string[]; msg?: string }
        if (Array.isArray(detail.message)) {
          msg = detail.message[0] || msg
        } else {
          msg = detail.message || detail.msg || exception.message || msg
        }
      } else {
        msg = exception.message || msg
      }
    } else if (exception instanceof Error) {
      msg = exception.message || msg
      this.logger.error(exception.message, exception.stack)
    } else {
      this.logger.error('未知异常', String(exception))
    }

    response.status(status).json({ code: status, msg, data: null })
  }
}