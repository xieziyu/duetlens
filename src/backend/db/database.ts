import BetterSqlite3, { type Database } from 'better-sqlite3';
import { migrate } from './schema';

export type DB = Database;

/**
 * 打开(或新建)本地 sqlite 库并跑迁移。
 * path=':memory:' 用于 headless 测试。
 *
 * 注意 ABI:better-sqlite3 是原生模块。`electron-forge start`/打包会用 @electron/rebuild
 * 把它重建为 Electron ABI;之后用 node/tsx 跑(如 db 测试)需 `npm rebuild better-sqlite3`
 * 切回 Node ABI。二者不可同时满足,按当前跑的运行时 rebuild。
 */
export function openDatabase(path: string): DB {
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
