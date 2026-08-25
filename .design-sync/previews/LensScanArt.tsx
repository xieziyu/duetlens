import { LensScanArt } from 'duetlens';

/** 刚起步:一行未点亮。 */
export const Idle = () => <LensScanArt lit={0} />;

/** 进行中:点亮的行数 = 已完成的阶段数。 */
export const Scanning = () => <LensScanArt lit={5} />;

/** 失败态:扫描停住,镜片居中转红环 —— 一眼看出不是还在跑。 */
export const Failed = () => <LensScanArt lit={2} failed />;
