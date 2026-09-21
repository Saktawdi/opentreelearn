import { Logger, ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module'
import { AllExceptionsFilter } from './common/http-exception.filter'
import {
  createCorsOrigin,
  shouldEnableDevToken,
  shouldEnableSwagger,
} from './common/runtime-security'

/** push 是批量提交，Nest 默认 100KB 的 body 上限不够用。 */
const BODY_LIMIT = '16mb'

async function bootstrap(): Promise<void> {
  // bodyParser 关掉默认、改用 useBodyParser 指定上限
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  })
  const config = app.get(ConfigService)
  const logger = new Logger('Bootstrap')

  app.setGlobalPrefix('api')
  app.useBodyParser('json', { limit: BODY_LIMIT })
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true })
  app.enableCors({ origin: createCorsOrigin(), credentials: true })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  app.useGlobalFilters(new AllExceptionsFilter())

  if (shouldEnableSwagger()) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('OpenTreeLearn Sync API')
        .setDescription('学习项目多端同步：账号映射 + 增量 pull/push')
        .setVersion('1.0')
        .addTag('auth', '认证（含开发联调 token）')
        .addTag('sync', '增量同步')
        .build(),
    )
    SwaggerModule.setup('api/docs', app, document)
  }

  const port = Number(config.get('PORT') ?? 3901)
  await app.listen(port)
  logger.log(`同步服务已启动：http://localhost:${port}/api`)
  if (shouldEnableSwagger()) {
    logger.log(`接口文档：http://localhost:${port}/api/docs`)
  }
  if (shouldEnableDevToken()) {
    logger.warn(
      'ALLOW_DEV_TOKEN=true：POST /api/auth/dev-token 会签发绕过账号系统的联调 token，仅限本机开发',
    )
  }
}

void bootstrap()