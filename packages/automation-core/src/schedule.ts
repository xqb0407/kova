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
  // 无法忠实表达进 cron 的语义一律显式报错（调度器把抛错落成任务级「调度错误」，
  // 用户可见可改）——静默降级会变成"用户以为每 2 天跑、实际每天都跑"的错语义
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  if (interval !== 1) {
    throw new Error(
      `Unsupported RRULE: INTERVAL=${parts.INTERVAL || 'invalid'} (only INTERVAL=1 is supported)`,
    );
  }
  const freq = parts.FREQ;
  const hour = parseRruleNumbers(parts.BYHOUR, 9, 0, 23);
  const minute = parseRruleNumbers(parts.BYMINUTE, 0, 0, 59);
  if (freq === 'HOURLY') {
    return `${minute} * * * *`;
  }
  if (freq === 'DAILY') {
    return `${minute} ${hour} * * *`;
  }
  if (freq === 'WEEKLY') {
    if (!parts.BYDAY) {
      throw new Error(
        'Unsupported RRULE: FREQ=WEEKLY requires BYDAY (the DTSTART weekday is not derived here)',
      );
    }
    const day = rruleDayToCron(parts.BYDAY);
    return `${minute} ${hour} * * ${day}`;
  }
  throw new Error(`Unsupported RRULE frequency: ${freq || 'missing'}`);
}

/**
 * BYHOUR/BYMINUTE 支持逗号多值（`9,18` → cron `9,18`，与 RRULE 多值语义一致）。
 * 整段缺失或存在越界/非法项时回落单值默认——部分保留会让触发时间悄悄减半。
 */
function parseRruleNumbers(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): string {
  if (value === undefined || value.trim() === '') {
    return String(fallback);
  }
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  const parsed = items.map((item) => Number(item));
  const valid = parsed.every((n) => Number.isInteger(n) && n >= min && n <= max);
  if (!valid || items.length === 0) {
    return String(fallback);
  }
  return [...new Set(parsed)].join(',');
}

function rruleDayToCron(value: string): string {
  const days: Record<string, string> = {
    SU: '0',
    MO: '1',
    TU: '2',
    WE: '3',
    TH: '4',
    FR: '5',
    SA: '6',
  };
  return value
    .split(',')
    .map((rawDay) => {
      const day = rawDay.trim();
      const mapped = days[day];
      if (!mapped) {
        throw new Error(
          `Unsupported RRULE BYDAY value: ${day} (ordinals/modifiers like -1SU are not supported)`,
        );
      }
      return mapped;
    })
    .join(',');
}
