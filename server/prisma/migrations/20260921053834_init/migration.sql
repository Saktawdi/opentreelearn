-- CreateTable
CREATE TABLE "accounts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "loginName" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "revCounter" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "records" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountId" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "rev" INTEGER NOT NULL,
    "clientUpdatedAt" REAL NOT NULL,
    "deletedAt" REAL,
    "data" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    CONSTRAINT "records_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_loginName_key" ON "accounts"("loginName");

-- CreateIndex
CREATE INDEX "records_accountId_rev_idx" ON "records"("accountId", "rev");

-- CreateIndex
CREATE UNIQUE INDEX "records_accountId_entity_localId_key" ON "records"("accountId", "entity", "localId");
