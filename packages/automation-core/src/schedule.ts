/**
 * VENDOR: RRULE/cron 归一化从原 vendored index.ts 拆出；见 NOTICE.md。
 *
 * 排期表达式的公共归一化逻辑。
 *
 * 单独成文件是为了避免 `catchup.ts` / `preview.ts` 反向依赖 `index.ts`
 * 造成循环导入；index 仍 re-export 保持既有导入路径稳定。
 */

export function scheduleExpressionForCroner(value: string): string {
  const schedule = value.trim();
  return schedule.toUpperCase().startsWith('RRULE:') ? rruleToCronSchedule(schedule) : schedule;
}

function rruleToCronSchedule(value: string): string {
  const body = value.trim().replace(/^RRULE:/i, '');
  const parts = Object.fromEntries(
    body.split(';').map((part) => {
      const [rawKey, rawValue = ''] = part.split('=');
      return [rawKey?.trim().toUpperCase() ?? '', rawValue.trim().toUpperCase()];
    }),
  );
  const freq = parts.FREQ;
  const hour = parseRruleNumber(parts.BYHOUR, 9, 0, 23);
  const minute = parseRruleNumber(parts.BYMINUTE, 0, 0, 59);
  if (freq === 'HOURLY') {
    return `${minute} * * * *`;
  }
  if (freq === 'DAILY') {
    return `${minute} ${hour} * * *`;
  }
  if (freq === 'WEEKLY') {
    const day = rruleDayToCron(parts.BYDAY);
    return `${minute} ${hour} * * ${day}`;
  }
  throw new Error(`Unsupported RRULE frequency: ${freq || 'missing'}`);
}

function parseRruleNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function rruleDayToCron(value: string | undefined): string {
  const days: Record<string, string> = {
    SU: '0',
    MO: '1',
    TU: '2',
    WE: '3',
    TH: '4',
    FR: '5',
    SA: '6',
  };
  if (!value) {
    return '*';
  }
  return value
    .split(',')
    .map((day) => days[day] ?? day)
    .join(',');
}
