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

const state = {
  params: [],
  bindings: [],
  keyState: new Set(),
  latestFrame: null,
  lastTimestampMs: 0,
  latestSeq: 0,
  pending: false,
  queued: false,
  trackingPort: null,
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

function dampen(value, target, dt, speed = 1) {
  if (!(dt > 0)) return target;
  let alpha = 1.0 - Math.pow(0.5, dt * speed * 60.0);
  alpha = clamp(alpha, 0, 1);
  return value + (target - value) * alpha;
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeKeyId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length === 1) return text.toUpperCase();
  return text.toLowerCase();
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
    ? { min: param.minX, max: param.maxX, defaultValue: param.defaultX }
    : { min: param.minY, max: param.maxY, defaultValue: param.defaultY };
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

function hasBlendshape(frame, sourceName) {
  return !!resolveBlendshapeName(frame, sourceName);
}

function getBlendshape(frame, sourceName) {
  const resolved = resolveBlendshapeName(frame, sourceName);
  return Number(resolved ? frame?.blendshapes?.[resolved] : 0);
}

function getBone(frame, sourceName) {
  return frame?.bones?.[sourceName] || null;
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
    if (!this.sourceName) return { ok: false, value: defaultValue };
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
    return { ok: valSet, value: unmapParamOffset(this.binding.param, this.binding.axis, this.outVal) };
  }
}

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
      }
    }
    if (this.method === COMPOUND_METHOD.WeightedSum && weightSum > 0) sum /= weightSum;
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
    parsed = JSON.parse(String(rawText).replace(/^\uFEFF/, "").replace(/\0+$/g, "").trim());
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const paramByUuid = new Map(params.map((param) => [param.uuid, param]));
  return parsed.map((item) => createBindingFromSpec(item, paramByUuid)).filter(Boolean);
}

function buildFallbackSpec(param, axis, sourceName, sourceType, inRange, options = {}) {
  return {
    bindingType: BINDING_TYPE.RatioBinding,
    param: param.uuid,
    axis,
    sourceType,
    sourceName,
    inRange,
    outRange: axis === 0 ? [param.minX, param.maxX] : [param.minY, param.maxY],
    dampenLevel: Number(options.dampenLevel ?? 4),
    inverse: !!options.inverse,
  };
}

function fallbackBindingsForParam(param) {
  const name = normalizeName(param.name);
  const out = [];
  const push = (axis, sourceName, sourceType, inRange, options) => {
    out.push(buildFallbackSpec(param, axis, sourceName, sourceType, inRange, options));
  };

  if (/anglex|headyaw|yaw|turn/.test(name)) push(0, "Head", SOURCE_TYPE.BoneRotYaw, [-30, 30]);
  else if (/angley|headpitch|pitch|tiltupdown/.test(name)) push(0, "Head", SOURCE_TYPE.BoneRotPitch, [-20, 20], { inverse: true });
  else if (/anglez|headroll|roll|tilt/.test(name)) push(0, "Head", SOURCE_TYPE.BoneRotRoll, [-25, 25]);
  else if (/mouthopen|jawopen|aaa|openmouth/.test(name)) push(0, "MouthOpen", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/blinkleft|eyeleftclose|eyeleftblink/.test(name)) push(0, "EyeBlinkLeft", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/blinkright|eyerightclose|eyerightblink/.test(name)) push(0, "EyeBlinkRight", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/blink|eyeclose|closeeye/.test(name)) push(0, "EyeBlinkLeft", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/smileleft/.test(name)) push(0, "MouthSmileLeft", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/smileright/.test(name)) push(0, "MouthSmileRight", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/smile|happy|mouthsmile/.test(name)) push(0, "MouthSmileLeft", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/brow|eyebrow/.test(name)) push(0, "BrowInnerUp", SOURCE_TYPE.Blendshape, [0, 1], { dampenLevel: 2 });
  else if (/gazerightx|eyerightx|lookrightx/.test(name)) push(0, "GazeRightX", SOURCE_TYPE.Blendshape, [-1, 1], { dampenLevel: 1 });
  else if (/gazerighty|eyerighty|lookrighty/.test(name)) push(0, "GazeRightY", SOURCE_TYPE.Blendshape, [-1, 1], { dampenLevel: 1 });
  else if (/gazeleftx|eyeleftx|lookleftx/.test(name)) push(0, "GazeLeftX", SOURCE_TYPE.Blendshape, [-1, 1], { dampenLevel: 1 });
  else if (/gazelefty|eyelefty|looklefty/.test(name)) push(0, "GazeLeftY", SOURCE_TYPE.Blendshape, [-1, 1], { dampenLevel: 1 });
  else if (param.isVec2 && /head|face|look|angle/.test(name)) {
    push(0, "Head", SOURCE_TYPE.BoneRotYaw, [-30, 30]);
    push(1, "Head", SOURCE_TYPE.BoneRotPitch, [-20, 20], { inverse: true });
  }
  return out;
}

function createFallbackBindings(params) {
  const paramByUuid = new Map(params.map((param) => [param.uuid, param]));
  const specs = [];
  for (const param of params) {
    specs.push(...fallbackBindingsForParam(param));
  }
  return specs.map((spec) => createBindingFromSpec(spec, paramByUuid)).filter(Boolean);
}

function mergeUpdates(updates) {
  const merged = new Map();
  for (const update of updates) {
    if (!update) continue;
    merged.set(update.uuid >>> 0, update);
  }
  return Array.from(merged.values());
}

function collectBindingCoverage(frame) {
  const sources = new Map();
  const collectEvaluator = (evaluator) => {
    if (!evaluator) return;
    if (evaluator instanceof CompoundBindingEvaluator) {
      for (const item of evaluator.bindingMap) {
        collectEvaluator(item?.binding?.evaluator);
      }
      return;
    }
    if (evaluator instanceof EventBindingEvaluator) {
      for (const item of evaluator.valueMap) {
        if (!item?.id) continue;
        const key = `${item.type}:${item.id}`;
        if (sources.has(key)) continue;
        const active = item.type === SOURCE_TYPE.KeyPress
          ? state.keyState.has(normalizeKeyId(item.id))
          : false;
        sources.set(key, { matched: active, active });
      }
      return;
    }
    if (!(evaluator instanceof RatioBindingEvaluator)) return;
    if (!evaluator.sourceName) return;
    const key = `${evaluator.sourceType}:${evaluator.sourceName}`;
    if (sources.has(key)) return;
    let matched = false;
    let active = false;
    switch (evaluator.sourceType) {
      case SOURCE_TYPE.Blendshape:
        matched = hasBlendshape(frame, evaluator.sourceName);
        if (matched) active = Math.abs(getBlendshape(frame, evaluator.sourceName)) > 0.01;
        break;
      case SOURCE_TYPE.BonePosX:
      case SOURCE_TYPE.BonePosY:
      case SOURCE_TYPE.BonePosZ:
      case SOURCE_TYPE.BoneRotRoll:
      case SOURCE_TYPE.BoneRotPitch:
      case SOURCE_TYPE.BoneRotYaw:
        matched = !!getBone(frame, evaluator.sourceName);
        if (matched) active = Math.abs(getSourceValue(frame, evaluator.sourceType, evaluator.sourceName)) > 0.01;
        break;
      case SOURCE_TYPE.KeyPress:
        matched = state.keyState.has(normalizeKeyId(evaluator.sourceName));
        active = matched;
        break;
    }
    sources.set(key, { matched, active });
  };
  for (const binding of state.bindings) {
    collectEvaluator(binding?.evaluator);
  }
  let matchedSourceCount = 0;
  let activeSourceCount = 0;
  const unresolved = [];
  for (const info of sources.values()) {
    if (info.matched) matchedSourceCount += 1;
    if (info.active) activeSourceCount += 1;
  }
  for (const [key, info] of sources.entries()) {
    if (info.matched) continue;
    unresolved.push(key.split(":").slice(1).join(":"));
  }
  return {
    sourceCount: sources.size,
    matchedSourceCount,
    activeSourceCount,
    unresolvedSources: unresolved.slice(0, 8).join(", "),
  };
}

function evaluateLatestFrame() {
  if (state.pending) {
    state.queued = true;
    return;
  }
  state.pending = true;
  queueMicrotask(() => {
    try {
      const frame = state.latestFrame;
      const dt = state.lastTimestampMs > 0 && Number.isFinite(frame?.timestampMs)
        ? Math.max(0, (frame.timestampMs - state.lastTimestampMs) / 1000.0)
        : 1 / 60;
      if (Number.isFinite(frame?.timestampMs)) {
        state.lastTimestampMs = frame.timestampMs;
      }
      const context = {
        frame,
        timeSeconds: (Number.isFinite(frame?.timestampMs) ? frame.timestampMs : performance.now()) / 1000.0,
        keyState: state.keyState,
      };
      const updates = frame
        ? mergeUpdates(state.bindings.map((binding) => binding.update(context, dt)))
        : [];
      const coverage = collectBindingCoverage(frame);
      self.postMessage({
        type: "binding-updates",
        seq: state.latestSeq,
        updates,
        sourceCount: coverage.sourceCount,
        matchedSourceCount: coverage.matchedSourceCount,
        activeSourceCount: coverage.activeSourceCount,
        unresolvedSources: coverage.unresolvedSources,
      });
    } catch (error) {
      self.postMessage({ type: "binding-error", error: String(error && error.message ? error.message : error) });
    } finally {
      state.pending = false;
      if (state.queued) {
        state.queued = false;
        evaluateLatestFrame();
      }
    }
  });
}

function handleMessage(data) {
  if (data.type === "frame") {
    state.latestFrame = {
      ...data.frame,
      timestampMs: Number(data.timestampMs) || performance.now(),
    };
    state.latestSeq = Number(data.seq) || 0;
    evaluateLatestFrame();
    return;
  }
  if (data.type === "config") {
    state.params = Array.isArray(data.params) ? data.params.map(makeParamMeta) : [];
    state.bindings = parseBindingSpecArray(String(data.bindingJsonText || ""), state.params);
    let bindingMode = data.bindingJsonText ? "ext" : "none";
    if (state.bindings.length === 0) {
      state.bindings = createFallbackBindings(state.params);
      if (state.bindings.length > 0) bindingMode = "fallback";
    }
    state.lastTimestampMs = 0;
    const coverage = collectBindingCoverage(state.latestFrame);
    self.postMessage({
      type: "binding-ready",
      bindingMode,
      bindingCount: state.bindings.length,
      sourceCount: coverage.sourceCount,
      matchedSourceCount: coverage.matchedSourceCount,
      activeSourceCount: coverage.activeSourceCount,
      unresolvedSources: coverage.unresolvedSources,
    });
    return;
  }
  if (data.type === "key-state") {
    if (data.action === "clear") {
      state.keyState.clear();
      return;
    }
    const key = normalizeKeyId(data.key);
    const code = normalizeKeyId(data.code);
    const apply = data.action === "down" ? "add" : "delete";
    if (key) state.keyState[apply](key);
    if (code) state.keyState[apply](code);
    if (code.startsWith("key") && code.length === 4) state.keyState[apply](code.slice(3).toUpperCase());
    return;
  }
}

self.onmessage = (event) => {
  const data = event?.data || {};
  if (data.type === "bind-tracking-port") {
    const [port] = event.ports || [];
    state.trackingPort = port || null;
    if (state.trackingPort) {
      state.trackingPort.onmessage = (portEvent) => {
        handleMessage(portEvent?.data || {});
      };
      state.trackingPort.start?.();
    }
    return;
  }
  handleMessage(data);
};
