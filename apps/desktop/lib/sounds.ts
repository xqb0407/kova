"use client";

import {
  AGENT_EVENT_REGISTRY,
  subscribeAgentEvents,
  type SoundTone,
} from "@/lib/agent-events";
import { getUiPrefs, type SoundPackName } from "@/lib/ui-prefs";

/**
 * 事件提示音：Web Audio 振荡器合成，零音频资源、音量可控。
 * 两套内置音色包（crisp=清脆 / calm=沉稳），整体切换 + 统一开关。
 * 门控链：总开关 → 仅后台开关（document.hasFocus）。
 * 浏览器自动播放策略要求用户手势后才能出声：首次 pointerdown/keydown
 * 解锁 AudioContext（正常使用必有任何点击，天然满足）。
 */

type ToneNote = {
  freq: number;
  /** 相对起播的延迟（秒） */
  at: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  /** 起音时长（秒）：越大越柔和 */
  attack?: number;
};

export const SOUND_PACKS: { value: SoundPackName; label: string; desc: string }[] = [
  { value: "crisp", label: "清脆", desc: "高频正弦，短促明亮" },
  { value: "calm", label: "沉稳", desc: "低频起音柔和，不刺耳" },
];

const TONE_PACKS: Record<SoundPackName, Record<SoundTone, ToneNote[]>> = {
  crisp: {
    // 两声上行：完成感
    complete: [
      { freq: 659.25, at: 0, dur: 0.12, type: "sine", gain: 0.5 },
      { freq: 880, at: 0.12, dur: 0.16, type: "sine", gain: 0.5 },
    ],
    // 低频两下：警示
    error: [
      { freq: 233.08, at: 0, dur: 0.14, type: "triangle", gain: 0.6 },
      { freq: 174.61, at: 0.16, dur: 0.2, type: "triangle", gain: 0.6 },
    ],
    // 叮咚双音：等待审批
    approval: [
      { freq: 587.33, at: 0, dur: 0.1, type: "sine", gain: 0.45 },
      { freq: 880, at: 0.09, dur: 0.22, type: "sine", gain: 0.4 },
    ],
    // 单声轻提示：等待回答
    question: [{ freq: 783.99, at: 0, dur: 0.18, type: "sine", gain: 0.45 }],
  },
  calm: {
    // 低两度上行，长起音：温和的完成音
    complete: [
      { freq: 523.25, at: 0, dur: 0.16, type: "sine", gain: 0.32, attack: 0.04 },
      { freq: 659.25, at: 0.16, dur: 0.26, type: "sine", gain: 0.3, attack: 0.04 },
    ],
    // 低音缓落：不炸耳的警示
    error: [
      { freq: 196, at: 0, dur: 0.2, type: "sine", gain: 0.42, attack: 0.03 },
      { freq: 164.81, at: 0.22, dur: 0.3, type: "sine", gain: 0.42, attack: 0.03 },
    ],
    // 纯五度轻响：柔和的等待音
    approval: [
      { freq: 392, at: 0, dur: 0.14, type: "sine", gain: 0.34, attack: 0.035 },
      { freq: 523.25, at: 0.13, dur: 0.3, type: "sine", gain: 0.3, attack: 0.035 },
    ],
    // 单声低吟
    question: [
      { freq: 440, at: 0, dur: 0.26, type: "sine", gain: 0.34, attack: 0.04 },
    ],
  },
};

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// 自动播放解锁：首次用户手势起停一次上下文
if (typeof document !== "undefined") {
  const unlock = () => {
    audioCtx();
  };
  document.addEventListener("pointerdown", unlock, { once: true });
  document.addEventListener("keydown", unlock, { once: true });
}

function playTone(tone: SoundTone, volume: number, pack: SoundPackName) {
  if (volume <= 0) return;
  const ac = audioCtx();
  if (!ac) return;
  const now = ac.currentTime;
  for (const note of TONE_PACKS[pack][tone]) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = note.type;
    osc.frequency.value = note.freq;
    const peak = Math.max(0.0001, note.gain * volume);
    const attack = note.attack ?? 0.015;
    gain.gain.setValueAtTime(0.0001, now + note.at);
    gain.gain.exponentialRampToValueAtTime(peak, now + note.at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + note.at);
    osc.stop(now + note.at + note.dur + 0.05);
  }
}

let initialized = false;

/** 挂到事件总线：生命周期事件 → 按偏好播放提示音。initNotifyPipeline 调用 */
export function initNotifySounds(): void {
  if (initialized) return;
  initialized = true;
  subscribeAgentEvents((event) => {
    const entry = AGENT_EVENT_REGISTRY.find((e) => e.name === event.name);
    if (!entry) return; // system.test 不发声
    const prefs = getUiPrefs();
    if (!prefs.soundEnabled) return;
    if (prefs.soundOnlyUnfocused && document.hasFocus()) return;
    playTone(entry.tone, prefs.soundVolume, prefs.soundPack);
  });
}
