const SOURCE_TYPE = {
  Blendshape: 0,
  BonePosX: 1,
  BonePosY: 2,
  BonePosZ: 3,
  BoneRotRoll: 4,
  BoneRotPitch: 5,
  BoneRotYaw: 6,
  KeyPress: 7,
};

const BINDING_TYPE = {
  RatioBinding: 0,
  ExpressionBinding: 1,
  EventBinding: 2,
  CompoundBinding: 3,
  External: 4,
};

const BINDING_TYPE_NAME = new Map([
  ["ratiobinding", BINDING_TYPE.RatioBinding],
  ["expressionbinding", BINDING_TYPE.ExpressionBinding],
  ["eventbinding", BINDING_TYPE.EventBinding],
  ["compoundbinding", BINDING_TYPE.CompoundBinding],
  ["external", BINDING_TYPE.External],
]);

const SOURCE_TYPE_NAME = new Map([
  ["blendshape", SOURCE_TYPE.Blendshape],
  ["boneposx", SOURCE_TYPE.BonePosX],
  ["boneposy", SOURCE_TYPE.BonePosY],
  ["boneposz", SOURCE_TYPE.BonePosZ],
  ["bonerotroll", SOURCE_TYPE.BoneRotRoll],
  ["bonerotpitch", SOURCE_TYPE.BoneRotPitch],
  ["bonerotyaw", SOURCE_TYPE.BoneRotYaw],
  ["keypress", SOURCE_TYPE.KeyPress],
]);

const BLENDSHAPE_ALIASES = new Map([
  ["eyeblinkleft", "eyeBlinkLeft"],
  ["eyeblinkright", "eyeBlinkRight"],
  ["eyeleftblink", "eyeBlinkLeft"],
  ["eyerightblink", "eyeBlinkRight"],
  ["mouthopen", "jawOpen"],
  ["jawopen", "jawOpen"],
  ["mouthsmileleft", "mouthSmileLeft"],
  ["mouthsmileright", "mouthSmileRight"],
  ["browinnerup", "browInnerUp"],
  ["browouterupleft", "browOuterUpLeft"],
  ["browouterupright", "browOuterUpRight"],
  ["browdownleft", "browDownLeft"],
  ["browdownright", "browDownRight"],
  ["eyeleftsquint", "eyeSquintLeft"],
  ["eyerightsquint", "eyeSquintRight"],
  ["eyesquintleft", "eyeSquintLeft"],
  ["eyesquintright", "eyeSquintRight"],
  ["gazeleftx", "GazeLeftX"],
  ["gazelefty", "GazeLeftY"],
  ["gazerightx", "GazeRightX"],
  ["gazerighty", "GazeRightY"],
]);


function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

function dampen(value, target, dt, speed = 1) {
  if (!(dt > 0)) return target;
  // Previous formula:
  // let alpha = 1.0 - Math.pow(0.5, dt * speed * 60.0);
  // It converged too aggressively at 60fps, so use a smoother exponential decay.
  let alpha = 1.0 - Math.exp(-dt * Math.max(0, speed) * 3.0);
  alpha = clamp(alpha, 0, 1);
  return value + (target - value) * alpha;
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mapValue(value, min, max) {
  const range = max - min;
  if (!Number.isFinite(range) || Math.abs(range) < 1e-6) return 0;
  return clamp((value - min) / range, 0, 1);
}

function unmapValue(offset, min, max) {
  return (max - min) * offset + min;
}

function quantize(value, step = 0.0001) {
  return Math.round(value / step) * step;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function cubicHermite(x, tx, y, ty, t) {
  const tt = t * t;
  const ttt = tt * t;
  const h00 = 2 * ttt - 3 * tt + 1;
  const h10 = ttt - 2 * tt + t;
  const h01 = -2 * ttt + 3 * tt;
  const h11 = ttt - tt;
  return h00 * x + h10 * tx + h01 * y + h11 * ty;
}

function degrees(value) {
  return value * (180 / Math.PI);
}

function radians(value) {
  return value * (Math.PI / 180);
}

function fract(value) {
  return value - Math.floor(value);
}

function noiseHash1(value) {
  return fract(Math.sin(value * 127.1 + 311.7) * 43758.5453123);
}

function smoothNoise1(value) {
  const base = Math.floor(value);
  const frac = value - base;
  const t = frac * frac * (3 - 2 * frac);
  const a = noiseHash1(base) * 2 - 1;
  const b = noiseHash1(base + 1) * 2 - 1;
  return lerp(a, b, t);
}

function readVec2Like(value, fallbackA, fallbackB) {
  if (Array.isArray(value)) {
    return [Number(value[0] ?? fallbackA), Number(value[1] ?? fallbackB)];
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.vector)) {
      return [Number(value.vector[0] ?? fallbackA), Number(value.vector[1] ?? fallbackB)];
    }
    if (Number.isFinite(value.x) || Number.isFinite(value.y)) {
      return [Number(value.x ?? fallbackA), Number(value.y ?? fallbackB)];
    }
    if (Number.isFinite(value[0]) || Number.isFinite(value[1])) {
      return [Number(value[0] ?? fallbackA), Number(value[1] ?? fallbackB)];
    }
  }
  return [fallbackA, fallbackB];
}

function parseEnumValue(value, nameMap, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return Number(value);
  const key = normalizeName(value);
  return nameMap.get(key) ?? fallback;
}


function makeParamMeta(param) {
  const min = Array.isArray(param?.min) ? param.min : [0, 0];
  const max = Array.isArray(param?.max) ? param.max : [1, 1];
  const defaults = Array.isArray(param?.defaults) ? param.defaults : [0, 0];
  return {
    uuid: Number(param?.uuid) >>> 0,
    name: String(param?.name || ""),
    isVec2: !!param?.isVec2,
    minX: Number(min[0] ?? 0),
    minY: Number(min[1] ?? 0),
    maxX: Number(max[0] ?? 1),
    maxY: Number(max[1] ?? 1),
    defaultX: Number(defaults[0] ?? 0),
    defaultY: Number(defaults[1] ?? 0),
    valueX: Number(defaults[0] ?? 0),
    valueY: Number(defaults[1] ?? 0),
  };
}

function getAxisMeta(param, axis) {
  return axis === 0
    ? { min: param.minX, max: param.maxX, value: param.valueX, defaultValue: param.defaultX }
    : { min: param.minY, max: param.maxY, value: param.valueY, defaultValue: param.defaultY };
}

function setAxisValue(param, axis, value) {
  if (axis === 0) param.valueX = value;
  else param.valueY = value;
}

function unmapParamOffset(param, axis, offset) {
  return axis === 0
    ? unmapValue(offset, param.minX, param.maxX)
    : unmapValue(offset, param.minY, param.maxY);
}

function resolveBlendshapeName(frame, sourceName) {
  if (!frame?.blendshapes || !sourceName) return "";
  if (Object.prototype.hasOwnProperty.call(frame.blendshapes, sourceName)) return sourceName;
  const normalized = normalizeName(sourceName);
  const alias = BLENDSHAPE_ALIASES.get(normalized);
  if (alias && Object.prototype.hasOwnProperty.call(frame.blendshapes, alias)) return alias;
  for (const name of Object.keys(frame.blendshapes)) {
    if (normalizeName(name) === normalized) return name;
  }
  return "";
}

function getBlendshape(frame, sourceName) {
  const resolved = resolveBlendshapeName(frame, sourceName);
  return Number(resolved ? frame?.blendshapes?.[resolved] : 0);
}

function getBone(frame, sourceName) {
  return frame?.bones?.[sourceName] || null;
}

function hasBlendshape(frame, sourceName) {
  return !!resolveBlendshapeName(frame, sourceName);
}

function getSourceValue(frame, sourceType, sourceName, keyState = null) {
  if (!sourceName) return 0;
  switch (sourceType) {
    case SOURCE_TYPE.Blendshape:
      return getBlendshape(frame, sourceName);
    case SOURCE_TYPE.BonePosX:
      return Number(getBone(frame, sourceName)?.position?.x ?? 0);
    case SOURCE_TYPE.BonePosY:
      return Number(getBone(frame, sourceName)?.position?.y ?? 0);
    case SOURCE_TYPE.BonePosZ:
      return Number(getBone(frame, sourceName)?.position?.z ?? 0);
    case SOURCE_TYPE.BoneRotRoll:
      return Number(getBone(frame, sourceName)?.rotation?.roll ?? 0);
    case SOURCE_TYPE.BoneRotPitch:
      return Number(getBone(frame, sourceName)?.rotation?.pitch ?? 0);
    case SOURCE_TYPE.BoneRotYaw:
      return Number(getBone(frame, sourceName)?.rotation?.yaw ?? 0);
    case SOURCE_TYPE.KeyPress:
      return keyState?.has(normalizeKeyId(sourceName)) ? 1 : 0;
    default:
      return 0;
  }
}

function normalizeKeyId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length === 1) return text.toUpperCase();
  return text.toLowerCase();
}

function makeExpressionScope(context) {
  const frame = context?.frame || null;
  return {
    BLEND: (name) => getBlendshape(frame, name),
    BONE_X: (name) => Number(getBone(frame, name)?.position?.x ?? 0),
    BONE_Y: (name) => Number(getBone(frame, name)?.position?.y ?? 0),
    BONE_Z: (name) => Number(getBone(frame, name)?.position?.z ?? 0),
    ROLL: (name) => Number(getBone(frame, name)?.rotation?.roll ?? 0),
    PITCH: (name) => Number(getBone(frame, name)?.rotation?.pitch ?? 0),
    YAW: (name) => Number(getBone(frame, name)?.rotation?.yaw ?? 0),
    time: () => Number(context?.timeSeconds ?? 0),
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    psin: (value) => clamp(Math.sin(value), 0, 1),
    pcos: (value) => clamp(Math.cos(value), 0, 1),
    ptan: (value) => clamp(Math.tan(value), 0, 1),
    usin: (value) => (1 + Math.sin(value)) / 2,
    ucos: (value) => (1 + Math.cos(value)) / 2,
    utan: (value) => (1 + Math.tan(value)) / 2,
    abs: Math.abs,
    sqrt: Math.sqrt,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    min: Math.min,
    max: Math.max,
    clamp,
    lerp,
    cubic: cubicHermite,
    atan2: Math.atan2,
    degrees,
    radians,
    simplex: smoothNoise1,
    usimplex: (value) => (1 + smoothNoise1(value)) / 2,
    sign: Math.sign,
  };
}

class RatioBindingEvaluator {
  constructor(binding, spec) {
    this.binding = binding;
    this.sourceType = parseEnumValue(spec?.sourceType, SOURCE_TYPE_NAME, SOURCE_TYPE.Blendshape);
    this.sourceName = String(spec?.sourceName || "");
    this.inverse = !!spec?.inverse;
    const [inMin, inMax] = readVec2Like(spec?.inRange, Number(spec?.inMin ?? 0), Number(spec?.inMax ?? 1));
    const [outMin, outMax] = readVec2Like(spec?.outRange, binding.axisMeta.min, binding.axisMeta.max);
    this.inMin = inMin;
    this.inMax = inMax;
    this.outMin = outMin;
    this.outMax = outMax;
    this.dampenLevel = Number(spec?.dampenLevel ?? 0) | 0;
    this.inVal = 0;
  }

  evaluate(context, dt) {
    const frame = context?.frame || null;
    const current = this.binding.getCurrentValue();
    const defaultValue = this.binding.axisMeta.defaultValue;
    if (!this.sourceName) {
      return { ok: false, value: defaultValue };
    }
    if (!frame?.hasFocus) {
      return { ok: true, value: quantize(dampen(current, defaultValue, dt, 1)) };
    }
    let target = mapValue(getSourceValue(frame, this.sourceType, this.sourceName, context?.keyState), this.inMin, this.inMax);
    if (this.inverse) target = 1 - target;
    if (this.dampenLevel === 0) this.inVal = target;
    else this.inVal = quantize(dampen(this.inVal, target, dt, 11 - this.dampenLevel));
    return { ok: true, value: unmapValue(this.inVal, this.outMin, this.outMax) };
  }
}

class ExpressionBindingEvaluator {
  constructor(binding, spec) {
    this.binding = binding;
    this.expressionSource = String(spec?.expression || "");
    this.dampenLevel = Number(spec?.dampenLevel ?? 0) | 0;
    this.outVal = 0;
    this.callable = null;
    if (this.expressionSource) {
      const argNames = Object.keys(makeExpressionScope({ frame: null, timeSeconds: 0, keyState: null }));
      try {
        this.callable = new Function(...argNames, `"use strict"; return (${this.expressionSource});`);
      } catch (_) {
        this.callable = null;
      }
    }
  }

  evaluate(context, dt) {
    if (!this.callable) return { ok: false, value: this.binding.axisMeta.defaultValue };
    let src;
    try {
      const scope = makeExpressionScope(context);
      src = Number(this.callable(...Object.values(scope)));
    } catch (_) {
      return { ok: false, value: this.binding.axisMeta.defaultValue };
    }
    if (!Number.isFinite(src)) return { ok: false, value: this.binding.axisMeta.defaultValue };
    if (this.dampenLevel === 0) this.outVal = src;
    else this.outVal = quantize(dampen(this.outVal, src, dt, 11 - this.dampenLevel));
    return { ok: true, value: unmapParamOffset(this.binding.param, this.binding.axis, this.outVal) };
  }
}

class EventBindingEvaluator {
  constructor(binding, spec) {
    this.binding = binding;
    this.dampenLevel = Number(spec?.dampenLevel ?? 0) | 0;
    this.outVal = 0;
    this.valueMap = Array.isArray(spec?.value_map)
      ? spec.value_map.map((item) => ({
          type: parseEnumValue(item?.type, SOURCE_TYPE_NAME, SOURCE_TYPE.KeyPress),
          id: String(item?.id || ""),
          value: Number(item?.value ?? 0),
        }))
      : [];
  }

  evaluate(context, dt) {
    let src = this.outVal;
    let valSet = false;
    for (const item of this.valueMap) {
      if (!item.id) {
        if (!valSet) {
          src = item.value;
          valSet = true;
        }
        continue;
      }
      const active = item.type === SOURCE_TYPE.KeyPress
        ? context?.keyState?.has(normalizeKeyId(item.id))
        : false;
      if (active) {
        src = item.value;
        valSet = true;
        break;
      }
    }
    if (this.dampenLevel === 0) this.outVal = src;
    else this.outVal = quantize(dampen(this.outVal, src, dt, 11 - this.dampenLevel));
    return {
      ok: valSet,
      value: unmapParamOffset(this.binding.param, this.binding.axis, this.outVal),
    };
  }
}

const COMPOUND_METHOD = {
  WeightedSum: 0,
  WeightedMul: 1,
  Ordered: 2,
};

const COMPOUND_METHOD_NAME = new Map([
  ["weightedsum", COMPOUND_METHOD.WeightedSum],
  ["weightedmul", COMPOUND_METHOD.WeightedMul],
  ["ordered", COMPOUND_METHOD.Ordered],
]);

class CompoundBindingEvaluator {
  constructor(binding, spec, createBinding) {
    this.binding = binding;
    this.method = parseEnumValue(spec?.method, COMPOUND_METHOD_NAME, COMPOUND_METHOD.WeightedSum);
    this.bindingMap = Array.isArray(spec?.binding_map)
      ? spec.binding_map.map((item) => ({
          weight: Number(item?.weight ?? 1),
          binding: createBinding({
            ...item,
            param: binding.param.uuid,
            axis: binding.axis,
            bindingType: item?.bindingType ?? item?.type_ ?? item?.type,
          }, true),
        })).filter((item) => item.binding)
      : [];
  }

  evaluate(context, dt) {
    let sum = this.method === COMPOUND_METHOD.WeightedMul ? 1 : 0;
    let weightSum = 0;
    let hasAny = false;
    for (const item of this.bindingMap) {
      const result = item.binding?.evaluator?.evaluate(context, dt);
      if (!result?.ok || !Number.isFinite(result.value)) continue;
      hasAny = true;
      switch (this.method) {
        case COMPOUND_METHOD.WeightedSum:
          weightSum += item.weight;
          sum += item.weight * result.value;
          break;
        case COMPOUND_METHOD.WeightedMul:
          if (item.weight !== 0) sum *= item.weight * result.value;
          break;
        case COMPOUND_METHOD.Ordered:
          if (item.weight > weightSum) {
            sum = result.value;
            weightSum = item.weight;
          }
          break;
        default:
          break;
      }
    }
    if (this.method === COMPOUND_METHOD.WeightedSum && weightSum > 0) {
      sum /= weightSum;
    }
    return { ok: hasAny || this.bindingMap.length === 0, value: sum };
  }
}

class TrackingBinding {
  constructor(param, axis, evaluator) {
    this.param = param;
    this.axis = axis;
    this.axisMeta = getAxisMeta(param, axis);
    this.evaluator = evaluator;
  }

  getCurrentValue() {
    return this.axis === 0 ? this.param.valueX : this.param.valueY;
  }

  update(context, dt) {
    if (!this.evaluator) return null;
    const result = this.evaluator.evaluate(context, dt);
    if (!result?.ok || !Number.isFinite(result.value)) return null;
    setAxisValue(this.param, this.axis, result.value);
    return {
      uuid: this.param.uuid,
      x: this.param.valueX,
      y: this.param.valueY,
    };
  }
}

function createTrackingBinding(param, axis, spec, allowNested = false) {
  const binding = new TrackingBinding(param, axis, null);
  const bindingType = parseEnumValue(spec?.bindingType ?? spec?.type_ ?? spec?.type, BINDING_TYPE_NAME, BINDING_TYPE.RatioBinding);
  switch (bindingType) {
    case BINDING_TYPE.RatioBinding:
      binding.evaluator = new RatioBindingEvaluator(binding, spec);
      break;
    case BINDING_TYPE.ExpressionBinding:
      binding.evaluator = new ExpressionBindingEvaluator(binding, spec);
      break;
    case BINDING_TYPE.EventBinding:
      binding.evaluator = new EventBindingEvaluator(binding, spec);
      break;
    case BINDING_TYPE.CompoundBinding:
      binding.evaluator = new CompoundBindingEvaluator(binding, spec, (childSpec, childAllowNested = false) => createTrackingBinding(param, axis, childSpec, childAllowNested));
      break;
    case BINDING_TYPE.External:
      if (!allowNested) return null;
      return null;
    default:
      return null;
  }
  return binding;
}

function createBindingFromSpec(spec, paramByUuid) {
  if (!spec || typeof spec !== "object") return null;
  const param = paramByUuid.get(Number(spec.param) >>> 0);
  if (!param) return null;
  const axis = clamp(Number(spec.axis ?? 0) | 0, 0, param.isVec2 ? 1 : 0);
  return createTrackingBinding(param, axis, spec);
}

function parseBindingSpecArray(rawText, params) {
  if (!rawText) return [];
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const paramByUuid = new Map(params.map((param) => [param.uuid, param]));
  return parsed.map((item) => createBindingFromSpec(item, paramByUuid)).filter(Boolean);
}

function mergeUpdates(updates) {
  const merged = new Map();
  for (const update of updates) {
    if (!update) continue;
    merged.set(update.uuid >>> 0, update);
  }
  return Array.from(merged.values());
}

function pickVideoFrameCallback(video) {
  if (typeof video.requestVideoFrameCallback === "function") {
    return {
      schedule(handler) {
        return video.requestVideoFrameCallback(handler);
      },
      cancel(handle) {
        if (handle) video.cancelVideoFrameCallback?.(handle);
      },
    };
  }
  return {
    schedule(handler) {
      return window.setTimeout(() => handler(performance.now(), {}), 1000 / 15);
    },
    cancel(handle) {
      if (handle) window.clearTimeout(handle);
    },
  };
}

export class WebcamTrackingController {
  constructor({ video, statusEl = null, log = () => {}, flipX = true, invertHorizontal = false, workerVersion = "", delegate = "CPU", onStateChange = null } = {}) {
    this.video = video;
    this.statusEl = statusEl;
    this.log = log;
    this.flipX = !!flipX;
    this.invertHorizontal = !!invertHorizontal;
    this.workerVersion = String(workerVersion || "");
    this.delegate = delegate === "CPU" ? "CPU" : "GPU";
    this.actualDelegate = this.delegate;
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
    this.params = [];
    this.worker = null;
    this.evaluatorWorker = null;
    this.stream = null;
    this.videoTrack = null;
    this.trackProcessor = null;
    this.trackReader = null;
    this.framePumpPromise = null;
    this.pendingBitmap = false;
    this.running = false;
    this.started = false;
    this.videoFrameHandle = 0;
    this.seq = 0;
    this.frameCallback = null;
    this.frameScheduler = null;
    this.startWatchdog = 0;
    this.lastVideoTime = -1;
    this.maxTrackingFps = 60;
    this.lastSubmittedFrameAt = 0;
    this.latestUpdates = [];
    this.usingBitmapFallback = false;
    this.keyState = new Set();
    this.keyDownHandler = (event) => {
      const key = normalizeKeyId(event?.key);
      const code = normalizeKeyId(event?.code);
      if (key) this.keyState.add(key);
      if (code) this.keyState.add(code);
      if (code.startsWith("key") && code.length === 4) this.keyState.add(code.slice(3).toUpperCase());
      this.evaluatorWorker?.postMessage({ type: "key-state", action: "down", key, code });
    };
    this.keyUpHandler = (event) => {
      const key = normalizeKeyId(event?.key);
      const code = normalizeKeyId(event?.code);
      if (key) this.keyState.delete(key);
      if (code) this.keyState.delete(code);
      if (code.startsWith("key") && code.length === 4) this.keyState.delete(code.slice(3).toUpperCase());
      this.evaluatorWorker?.postMessage({ type: "key-state", action: "up", key, code });
    };
    this.blurHandler = () => {
      this.keyState.clear();
      this.evaluatorWorker?.postMessage({ type: "key-state", action: "clear" });
    };
    this.debug = {
      frameSeq: 0,
      blendshapeCount: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      lastReason: "off",
      ready: false,
      bindingMode: "none",
      bindingCount: 0,
      sourceCount: 0,
      matchedSourceCount: 0,
      activeSourceCount: 0,
      updateCount: 0,
      topBlendshapes: "",
      unresolvedSources: "",
      workerFps: 0,
      evaluatorFps: 0,
    };
    this.appBasePath = new URL("../", import.meta.url).pathname;
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = String(text || "");
    this.notifyStateChange();
  }

  notifyStateChange() {
    this.onStateChange?.({
      started: this.started,
      requestedDelegate: this.delegate,
      actualDelegate: this.actualDelegate,
      status: this.statusEl ? this.statusEl.textContent : "",
      ready: this.debug.ready,
    });
  }

  getActualDelegate() {
    return this.actualDelegate;
  }

  getFpsCounters() {
    return {
      trackingWorker: Number(this.debug.workerFps || 0),
      evaluatorWorker: Number(this.debug.evaluatorFps || 0),
    };
  }

  collectTopBlendshapes(frame, limit = 5) {
    const entries = Object.entries(frame?.blendshapes || {})
      .filter(([, value]) => Number.isFinite(value) && Math.abs(value) > 0.01)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, limit);
    return entries.map(([name, value]) => `${name}=${Number(value).toFixed(2)}`).join(", ");
  }

  updateStatusFromFrame(frame) {
    const reason = frame?.reason || "unknown";
    this.debug.lastReason = reason;
    if (!frame?.hasFocus) {
      this.debug.blendshapeCount = 0;
      this.debug.yaw = 0;
      this.debug.pitch = 0;
      this.debug.roll = 0;
      this.debug.topBlendshapes = "";
      this.setStatus(`tracking idle (${reason})`);
      return;
    }
    const head = frame?.bones?.Head || null;
    const rotation = head?.rotation || {};
    const blendshapeCount = Object.keys(frame?.blendshapes || {}).length;
    this.debug.blendshapeCount = blendshapeCount;
    this.debug.yaw = Number(rotation.yaw || 0);
    this.debug.pitch = Number(rotation.pitch || 0);
    this.debug.roll = Number(rotation.roll || 0);
    this.debug.topBlendshapes = this.collectTopBlendshapes(frame);
    this.setStatus("tracking active");
  }

  updateStatusFromSummary(summary) {
    const reason = summary?.reason || "unknown";
    this.debug.lastReason = reason;
    if (!summary?.hasFocus) {
      this.debug.blendshapeCount = 0;
      this.debug.yaw = 0;
      this.debug.pitch = 0;
      this.debug.roll = 0;
      this.debug.topBlendshapes = "";
      this.setStatus(`tracking idle (${reason})`);
      return;
    }
    this.debug.blendshapeCount = Number(summary?.blendshapeCount || 0);
    this.debug.yaw = Number(summary?.yaw || 0);
    this.debug.pitch = Number(summary?.pitch || 0);
    this.debug.roll = Number(summary?.roll || 0);
    this.debug.topBlendshapes = String(summary?.topBlendshapes || "");
    if (this.debug.bindingMode === "none" || this.debug.bindingCount === 0) {
      this.setStatus("tracking active (no bindings)");
      return;
    }
    if (this.debug.matchedSourceCount === 0) {
      this.setStatus("tracking active (bindings unresolved)");
      return;
    }
    this.setStatus("tracking active");
  }

  configure(params, bindingJsonText = "") {
    this.params = params.map(makeParamMeta);
    this.bindingJsonText = String(bindingJsonText || "");
    this.debug.bindingMode = this.bindingJsonText ? "ext" : "none";
    this.debug.bindingCount = 0;
    this.debug.sourceCount = 0;
    this.debug.matchedSourceCount = 0;
    this.debug.activeSourceCount = 0;
    this.debug.updateCount = 0;
    this.debug.unresolvedSources = "";
    this.debug.workerFps = 0;
    this.debug.evaluatorFps = 0;
    this.applyEvaluatorConfig();
    this.setStatus("tracking ready");
  }

  attachInputListeners() {
    window.addEventListener("keydown", this.keyDownHandler, true);
    window.addEventListener("keyup", this.keyUpHandler, true);
    window.addEventListener("blur", this.blurHandler, true);
  }

  detachInputListeners() {
    window.removeEventListener("keydown", this.keyDownHandler, true);
    window.removeEventListener("keyup", this.keyUpHandler, true);
    window.removeEventListener("blur", this.blurHandler, true);
    this.keyState.clear();
  }

  applyWorkerConfig() {
    if (!this.worker) return;
    this.worker.postMessage({
      type: "config",
      config: {
        flipX: this.flipX,
        invertHorizontal: this.invertHorizontal,
        delegate: this.delegate,
        wasmPath: `${this.appBasePath}vendor/package/wasm`,
        modelAssetPath: `${this.appBasePath}tracking/face_landmarker_v2_with_blendshapes.task`,
      },
    });
  }

  applyEvaluatorConfig() {
    if (!this.evaluatorWorker) return;
    this.evaluatorWorker.postMessage({
      type: "config",
      params: this.params,
      bindingJsonText: this.bindingJsonText || "",
    });
  }

  setTrackingOptions({ invertHorizontal, delegate } = {}) {
    if (typeof invertHorizontal === "boolean") {
      this.invertHorizontal = invertHorizontal;
    }
    if (typeof delegate === "string") {
      this.delegate = delegate === "CPU" ? "CPU" : "GPU";
      this.actualDelegate = this.delegate;
    }
    this.applyWorkerConfig();
    this.notifyStateChange();
  }

  async start() {
    if (this.started) return;
    if (!this.video) throw new Error("tracking video element is missing");
    const workerUrl = new URL("./face_tracking_worker.js", import.meta.url);
    const evaluatorWorkerUrl = new URL("./tracking_evaluator_worker.js", import.meta.url);
    if (this.workerVersion) workerUrl.searchParams.set("v", this.workerVersion);
    if (this.workerVersion) evaluatorWorkerUrl.searchParams.set("v", this.workerVersion);
    this.worker = new Worker(workerUrl);
    this.evaluatorWorker = new Worker(evaluatorWorkerUrl);
    const trackingChannel = new MessageChannel();
    this.worker.postMessage({ type: "bind-evaluator-port" }, [trackingChannel.port1]);
    this.evaluatorWorker.postMessage({ type: "bind-tracking-port" }, [trackingChannel.port2]);
    this.worker.onmessage = (event) => {
      const data = event?.data || {};
      if (data.type === "tracking-ready") {
        this.actualDelegate = data.delegate === "GPU" ? "GPU" : "CPU";
        this.debug.ready = true;
        this.log("tracking worker ready");
        if (this.started && this.debug.frameSeq === 0) {
          this.setStatus("tracking worker ready, waiting for first frame");
        }
      } else if (data.type === "tracking-warning") {
        this.actualDelegate = data.delegate === "GPU" ? "GPU" : "CPU";
        this.log(data.warning || "tracking warning");
        this.setStatus(String(data.warning || "tracking warning"));
      } else if (data.type === "tracking-status") {
        this.pendingBitmap = false;
        this.debug.frameSeq = Number(data.seq) || 0;
        this.debug.workerFps = Number(data.workerFps || 0);
        this.updateStatusFromSummary(data.status || null);
      } else if (data.type === "tracking-error") {
        this.pendingBitmap = false;
        this.setStatus(`tracking error: ${data.error || "unknown"}`);
      }
    };
    this.worker.onerror = (event) => {
      this.pendingBitmap = false;
      this.setStatus(`tracking error: ${String(event?.message || "worker failed to load")}`);
    };
    this.evaluatorWorker.onmessage = (event) => {
      const data = event?.data || {};
      if (data.type === "binding-ready") {
        this.debug.bindingMode = String(data.bindingMode || this.debug.bindingMode || "none");
        this.debug.bindingCount = Number(data.bindingCount || 0);
        this.debug.sourceCount = Number(data.sourceCount || 0);
        this.debug.matchedSourceCount = Number(data.matchedSourceCount || 0);
        this.debug.activeSourceCount = Number(data.activeSourceCount || 0);
        this.debug.unresolvedSources = String(data.unresolvedSources || "");
      } else if (data.type === "binding-updates") {
        this.latestUpdates = Array.isArray(data.updates) ? data.updates : [];
        this.debug.updateCount = this.latestUpdates.length;
        this.debug.evaluatorFps = Number(data.evaluatorFps || 0);
        this.debug.sourceCount = Number(data.sourceCount || 0);
        this.debug.matchedSourceCount = Number(data.matchedSourceCount || 0);
        this.debug.activeSourceCount = Number(data.activeSourceCount || 0);
        this.debug.unresolvedSources = String(data.unresolvedSources || "");
      } else if (data.type === "binding-error") {
        this.setStatus(`tracking error: ${data.error || "binding worker failed"}`);
      }
    };
    this.evaluatorWorker.onerror = (event) => {
      this.setStatus(`tracking error: ${String(event?.message || "binding worker failed to load")}`);
    };
    this.applyWorkerConfig();
    this.applyEvaluatorConfig();
    this.attachInputListeners();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
    this.videoTrack = this.stream.getVideoTracks?.()[0] || null;
    this.running = true;
    if (typeof MediaStreamTrackProcessor === "function" && this.videoTrack) {
      this.trackProcessor = new MediaStreamTrackProcessor({ track: this.videoTrack });
      this.trackReader = this.trackProcessor.readable.getReader();
      this.framePumpPromise = this.pumpTrackFrames();
    } else {
      if (!this.usingBitmapFallback) {
        this.usingBitmapFallback = true;
        console.warn("[nijikan] tracking fallback: using createImageBitmap(video) on main thread");
      }
      if (!this.video) throw new Error("tracking video element is missing");
      this.video.srcObject = this.stream;
      await this.video.play();
      this.frameScheduler = pickVideoFrameCallback(this.video);
      this.frameCallback = async () => {
        if (!this.running) return;
        if (!this.pendingBitmap && this.worker && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          try {
            if (this.video.currentTime === this.lastVideoTime) {
              this.videoFrameHandle = this.frameScheduler.schedule(this.frameCallback);
              return;
            }
            this.lastVideoTime = this.video.currentTime;
            const nowMs = performance.now();
            if (this.lastSubmittedFrameAt > 0 && (nowMs - this.lastSubmittedFrameAt) < (1000 / this.maxTrackingFps)) {
              this.videoFrameHandle = this.frameScheduler.schedule(this.frameCallback);
              return;
            }
            const bitmap = await createImageBitmap(this.video);
            this.pendingBitmap = true;
            this.lastSubmittedFrameAt = nowMs;
            this.worker.postMessage({
              type: "frame",
              seq: ++this.seq,
              timestampMs: nowMs,
              bitmap,
            }, [bitmap]);
          } catch (error) {
            this.setStatus(`tracking error: ${String(error && error.message ? error.message : error)}`);
          }
        }
        this.videoFrameHandle = this.frameScheduler.schedule(this.frameCallback);
      };
      this.videoFrameHandle = this.frameScheduler.schedule(this.frameCallback);
    }
    this.started = true;
    this.actualDelegate = this.delegate;
    this.setStatus("camera started, waiting for face");
    this.startWatchdog = window.setTimeout(() => {
      if (!this.started) return;
      if (!this.debug.ready) {
        this.setStatus("tracking error: worker did not initialize");
        return;
      }
      if (this.debug.frameSeq === 0) {
        this.setStatus("tracking error: no frame response from tracker");
      }
    }, 4000);
  }

  stop() {
    this.running = false;
    if (this.videoFrameHandle) {
      this.frameScheduler?.cancel(this.videoFrameHandle);
      this.videoFrameHandle = 0;
    }
    this.frameScheduler = null;
    if (this.trackReader) {
      this.trackReader.cancel().catch(() => {});
      this.trackReader.releaseLock?.();
      this.trackReader = null;
    }
    this.trackProcessor = null;
    this.framePumpPromise = null;
    this.videoTrack = null;
    if (this.startWatchdog) {
      window.clearTimeout(this.startWatchdog);
      this.startWatchdog = 0;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.evaluatorWorker) {
      this.evaluatorWorker.terminate();
      this.evaluatorWorker = null;
    }
    this.detachInputListeners();
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.video) {
      this.video.pause?.();
      this.video.srcObject = null;
    }
    this.pendingBitmap = false;
    this.started = false;
    this.debug.lastReason = "stopped";
    this.debug.ready = false;
    this.debug.updateCount = 0;
    this.debug.workerFps = 0;
    this.debug.evaluatorFps = 0;
    this.actualDelegate = this.delegate;
    this.latestUpdates = [];
    this.lastSubmittedFrameAt = 0;
    this.usingBitmapFallback = false;
    this.setStatus("tracking stopped");
  }

  update(dt, nowMs = performance.now()) {
    if (!this.started) {
      this.debug.updateCount = 0;
      return [];
    }
    if (!this.latestUpdates.length) {
      this.debug.updateCount = 0;
      return [];
    }
    const updates = this.latestUpdates;
    this.latestUpdates = [];
    this.debug.updateCount = updates.length;
    return updates;
  }

  async pumpTrackFrames() {
    while (this.running && this.trackReader && this.worker) {
      let record;
      try {
        record = await this.trackReader.read();
      } catch (_) {
        break;
      }
      if (!record || record.done) break;
      const frame = record.value;
      if (!frame) continue;
      const timestampUs = Number(frame.timestamp);
      const timestampMs = Number.isFinite(timestampUs) ? (timestampUs / 1000.0) : performance.now();
      if (this.lastSubmittedFrameAt > 0 && (timestampMs - this.lastSubmittedFrameAt) < (1000 / this.maxTrackingFps)) {
        try { frame.close?.(); } catch (_) {}
        continue;
      }
      if (this.pendingBitmap) {
        try { frame.close?.(); } catch (_) {}
        continue;
      }
      this.pendingBitmap = true;
      this.lastSubmittedFrameAt = timestampMs;
      try {
        this.worker.postMessage({
          type: "frame",
          seq: ++this.seq,
          timestampMs,
          videoFrame: frame,
        }, [frame]);
      } catch (error) {
        this.pendingBitmap = false;
        try { frame.close?.(); } catch (_) {}
        this.setStatus(`tracking error: ${String(error && error.message ? error.message : error)}`);
        break;
      }
    }
  }
}
