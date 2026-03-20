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
  let alpha = 1.0 - Math.pow(0.5, dt * speed * 60.0);
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

  readSource(frame) {
    if (!this.sourceName) return 0;
    switch (this.sourceType) {
      case SOURCE_TYPE.Blendshape:
        return getBlendshape(frame, this.sourceName);
      case SOURCE_TYPE.BonePosX:
        return Number(getBone(frame, this.sourceName)?.position?.x ?? 0);
      case SOURCE_TYPE.BonePosY:
        return Number(getBone(frame, this.sourceName)?.position?.y ?? 0);
      case SOURCE_TYPE.BonePosZ:
        return Number(getBone(frame, this.sourceName)?.position?.z ?? 0);
      case SOURCE_TYPE.BoneRotRoll:
        return Number(getBone(frame, this.sourceName)?.rotation?.roll ?? 0);
      case SOURCE_TYPE.BoneRotPitch:
        return Number(getBone(frame, this.sourceName)?.rotation?.pitch ?? 0);
      case SOURCE_TYPE.BoneRotYaw:
        return Number(getBone(frame, this.sourceName)?.rotation?.yaw ?? 0);
      default:
        return 0;
    }
  }

  evaluate(frame, dt) {
    const current = this.binding.getCurrentValue();
    const defaultValue = this.binding.axisMeta.defaultValue;
    if (!frame?.hasFocus) {
      return quantize(dampen(current, defaultValue, dt, 1));
    }
    let target = mapValue(this.readSource(frame), this.inMin, this.inMax);
    if (this.inverse) target = 1 - target;
    if (this.dampenLevel === 0) this.inVal = target;
    else this.inVal = quantize(dampen(this.inVal, target, dt, 11 - this.dampenLevel));
    return unmapValue(this.inVal, this.outMin, this.outMax);
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

  update(frame, dt) {
    if (!this.evaluator) return null;
    const next = this.evaluator.evaluate(frame, dt);
    if (!Number.isFinite(next)) return null;
    setAxisValue(this.param, this.axis, next);
    return {
      uuid: this.param.uuid,
      x: this.param.valueX,
      y: this.param.valueY,
    };
  }
}

function createRatioBinding(param, axis, spec) {
  const binding = new TrackingBinding(param, axis, null);
  binding.evaluator = new RatioBindingEvaluator(binding, spec);
  return binding;
}

function createBindingFromSpec(spec, paramByUuid) {
  if (!spec || typeof spec !== "object") return null;
  const bindingType = parseEnumValue(spec.bindingType ?? spec.type_ ?? spec.type, BINDING_TYPE_NAME, BINDING_TYPE.RatioBinding);
  if (bindingType !== BINDING_TYPE.RatioBinding) return null;
  const param = paramByUuid.get(Number(spec.param) >>> 0);
  if (!param) return null;
  const axis = clamp(Number(spec.axis ?? 0) | 0, 0, param.isVec2 ? 1 : 0);
  return createRatioBinding(param, axis, spec);
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
  constructor({ video, statusEl = null, debugEl = null, log = () => {}, flipX = true, invertHorizontal = false } = {}) {
    this.video = video;
    this.statusEl = statusEl;
    this.debugEl = debugEl;
    this.log = log;
    this.flipX = !!flipX;
    this.invertHorizontal = !!invertHorizontal;
    this.params = [];
    this.bindings = [];
    this.worker = null;
    this.stream = null;
    this.videoTrack = null;
    this.trackProcessor = null;
    this.trackReader = null;
    this.framePumpPromise = null;
    this.latestFrame = null;
    this.pendingBitmap = false;
    this.running = false;
    this.started = false;
    this.videoFrameHandle = 0;
    this.seq = 0;
    this.frameCallback = null;
    this.frameScheduler = null;
    this.startWatchdog = 0;
    this.lastVideoTime = -1;
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
    };
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = String(text || "");
  }

  setDebugText(text) {
    if (this.debugEl) this.debugEl.textContent = String(text || "");
  }

  refreshDebugText() {
    const lines = [
      `input: ${this.latestFrame?.hasFocus ? "face" : "none"} reason=${this.debug.lastReason} frame=${this.debug.frameSeq}`,
      `head: yaw=${this.debug.yaw.toFixed(1)} pitch=${this.debug.pitch.toFixed(1)} roll=${this.debug.roll.toFixed(1)} blendshapes=${this.debug.blendshapeCount}`,
      `bindings: mode=${this.debug.bindingMode} total=${this.debug.bindingCount} sources=${this.debug.matchedSourceCount}/${this.debug.sourceCount} active=${this.debug.activeSourceCount} updates=${this.debug.updateCount}`,
      `top: ${this.debug.topBlendshapes || "-"}`,
      `missing: ${this.debug.unresolvedSources || "-"}`,
    ];
    this.setDebugText(lines.join("\n"));
  }

  collectTopBlendshapes(frame, limit = 5) {
    const entries = Object.entries(frame?.blendshapes || {})
      .filter(([, value]) => Number.isFinite(value) && Math.abs(value) > 0.01)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, limit);
    return entries.map(([name, value]) => `${name}=${Number(value).toFixed(2)}`).join(", ");
  }

  collectBindingCoverage(frame) {
    const sources = new Map();
    for (const binding of this.bindings) {
      const evaluator = binding?.evaluator;
      if (!evaluator?.sourceName) continue;
      const key = `${evaluator.sourceType}:${evaluator.sourceName}`;
      if (sources.has(key)) continue;
      let matched = false;
      let active = false;
      switch (evaluator.sourceType) {
        case SOURCE_TYPE.Blendshape: {
          matched = hasBlendshape(frame, evaluator.sourceName);
          if (matched) active = Math.abs(getBlendshape(frame, evaluator.sourceName)) > 0.01;
          break;
        }
        case SOURCE_TYPE.BonePosX:
        case SOURCE_TYPE.BonePosY:
        case SOURCE_TYPE.BonePosZ:
        case SOURCE_TYPE.BoneRotRoll:
        case SOURCE_TYPE.BoneRotPitch:
        case SOURCE_TYPE.BoneRotYaw: {
          const bone = getBone(frame, evaluator.sourceName);
          matched = !!bone;
          if (matched) active = Math.abs(evaluator.readSource(frame)) > 0.01;
          break;
        }
        default:
          break;
      }
      sources.set(key, { matched, active });
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

  updateStatusFromFrame(frame) {
    const reason = frame?.reason || "unknown";
    this.debug.lastReason = reason;
    if (!frame?.hasFocus) {
      this.debug.blendshapeCount = 0;
      this.debug.yaw = 0;
      this.debug.pitch = 0;
      this.debug.roll = 0;
      this.debug.topBlendshapes = "";
      const coverage = this.collectBindingCoverage(frame);
      this.debug.sourceCount = coverage.sourceCount;
      this.debug.matchedSourceCount = coverage.matchedSourceCount;
      this.debug.activeSourceCount = coverage.activeSourceCount;
      this.debug.unresolvedSources = coverage.unresolvedSources;
      this.setStatus(`tracking idle (${reason})`);
      this.refreshDebugText();
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
    this.setStatus(
      `tracking active face=${blendshapeCount} yaw=${this.debug.yaw.toFixed(1)} pitch=${this.debug.pitch.toFixed(1)} roll=${this.debug.roll.toFixed(1)}`,
    );
    const coverage = this.collectBindingCoverage(frame);
    this.debug.sourceCount = coverage.sourceCount;
    this.debug.matchedSourceCount = coverage.matchedSourceCount;
    this.debug.activeSourceCount = coverage.activeSourceCount;
    this.debug.unresolvedSources = coverage.unresolvedSources;
    this.refreshDebugText();
  }

  configure(params, bindingJsonText = "") {
    this.params = params.map(makeParamMeta);
    this.bindings = parseBindingSpecArray(bindingJsonText, this.params);
    this.debug.bindingMode = "ext";
    if (this.bindings.length === 0) {
      this.bindings = createFallbackBindings(this.params);
      this.debug.bindingMode = "fallback";
    }
    this.debug.bindingCount = this.bindings.length;
    this.debug.sourceCount = 0;
    this.debug.matchedSourceCount = 0;
    this.debug.activeSourceCount = 0;
    this.debug.updateCount = 0;
    this.debug.unresolvedSources = "";
    this.setStatus(this.bindings.length > 0 ? `tracking ready (${this.bindings.length} bindings)` : "tracking ready (no bindings)");
    this.refreshDebugText();
  }

  applyWorkerConfig() {
    if (!this.worker) return;
    this.worker.postMessage({
      type: "config",
      config: {
        flipX: this.flipX,
        invertHorizontal: this.invertHorizontal,
        wasmPath: "/vendor/package/wasm",
        modelAssetPath: "/tracking/face_landmarker_v2_with_blendshapes.task",
      },
    });
  }

  setTrackingOptions({ invertHorizontal } = {}) {
    if (typeof invertHorizontal === "boolean") {
      this.invertHorizontal = invertHorizontal;
    }
    this.applyWorkerConfig();
  }

  async start() {
    if (this.started) return;
    if (!this.video) throw new Error("tracking video element is missing");
    this.worker = new Worker(new URL("./face_tracking_worker.js", import.meta.url));
    this.worker.onmessage = (event) => {
      const data = event?.data || {};
      if (data.type === "tracking-ready") {
        this.debug.ready = true;
        this.log("tracking worker ready");
        if (this.started && this.debug.frameSeq === 0) {
          this.setStatus("tracking worker ready, waiting for first frame");
        }
      } else if (data.type === "tracking") {
        this.latestFrame = data.frame || null;
        this.pendingBitmap = false;
        this.debug.frameSeq = Number(data.seq) || 0;
        this.updateStatusFromFrame(this.latestFrame);
      } else if (data.type === "tracking-error") {
        this.pendingBitmap = false;
        this.setStatus(`tracking error: ${data.error || "unknown"}`);
        this.refreshDebugText();
      }
    };
    this.worker.onerror = (event) => {
      this.pendingBitmap = false;
      this.setStatus(`tracking error: ${String(event?.message || "worker failed to load")}`);
      this.refreshDebugText();
    };
    this.applyWorkerConfig();

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
            const bitmap = await createImageBitmap(this.video);
            this.pendingBitmap = true;
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
    this.latestFrame = null;
    this.debug.lastReason = "stopped";
    this.debug.ready = false;
    this.debug.updateCount = 0;
    this.setStatus("tracking stopped");
    this.refreshDebugText();
  }

  update(dt) {
    if (!this.started || this.bindings.length === 0) {
      this.debug.updateCount = 0;
      this.refreshDebugText();
      return [];
    }
    const updates = mergeUpdates(this.bindings.map((binding) => binding.update(this.latestFrame, dt)));
    this.debug.updateCount = updates.length;
    this.refreshDebugText();
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
      if (this.pendingBitmap) {
        try { frame.close?.(); } catch (_) {}
        continue;
      }
      this.pendingBitmap = true;
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
