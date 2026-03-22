function getAppBasePath() {
  const pathname = String(self.location?.pathname || "/");
  const suffix = "/tracking/face_tracking_worker.js";
  if (pathname.endsWith(suffix)) return pathname.slice(0, -suffix.length + 1);
  return "/nijikan/";
}

const APP_BASE_PATH = getAppBasePath();

async function ensureTasksVisionLoaded() {
  if (self.__mediapipeTasksVision) return self.__mediapipeTasksVision;
  self.exports = self.exports || {};
  self.module = self.module || { exports: self.exports };
  const bundleUrl = `${APP_BASE_PATH}vendor/package/vision_bundle.cjs`;
  const response = await fetch(bundleUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed to fetch tasks vision bundle: ${response.status}`);
  }
  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  try {
    importScripts(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  self.__mediapipeTasksVision = self.module?.exports || self.exports;
  return self.__mediapipeTasksVision;
}

const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const CHIN = 152;
const NOSE_TIP = 1;
const RIGHT_IRIS_CENTER = 468;
const RIGHT_EYE_INNER = 133;
const RIGHT_EYE_TOP = 159;
const RIGHT_EYE_BOTTOM = 145;
const LEFT_IRIS_CENTER = 473;
const LEFT_EYE_OUTER_MP = 362;
const LEFT_EYE_INNER_MP = 263;
const LEFT_EYE_TOP = 386;
const LEFT_EYE_BOTTOM = 374;

const state = {
  faceLandmarker: null,
  taskCanvas: null,
  taskGl: null,
  evaluatorPort: null,
  config: {
    runningMode: "VIDEO",
    wasmPath: `${APP_BASE_PATH}vendor/package/wasm`,
    modelAssetPath: `${APP_BASE_PATH}tracking/face_landmarker_v2_with_blendshapes.task`,
    delegate: "CPU",
    numFaces: 1,
    flipX: true,
    invertHorizontal: false,
  },
};

function collectTopBlendshapes(frame, limit = 5) {
  const entries = Object.entries(frame?.blendshapes || {})
    .filter(([, value]) => Number.isFinite(value) && Math.abs(value) > 0.01)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, limit);
  return entries.map(([name, value]) => `${name}=${Number(value).toFixed(2)}`).join(", ");
}

function buildTrackingStatus(frame) {
  if (!frame?.hasFocus) {
    return {
      hasFocus: false,
      reason: String(frame?.reason || "unknown"),
      blendshapeCount: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      topBlendshapes: "",
    };
  }
  const head = frame?.bones?.Head || null;
  const rotation = head?.rotation || {};
  return {
    hasFocus: true,
    reason: "ok",
    blendshapeCount: Object.keys(frame?.blendshapes || {}).length,
    yaw: Number(rotation.yaw || 0),
    pitch: Number(rotation.pitch || 0),
    roll: Number(rotation.roll || 0),
    topBlendshapes: collectTopBlendshapes(frame),
  };
}

function closeFaceLandmarker() {
  try {
    state.faceLandmarker?.close?.();
  } catch (_) {}
  state.faceLandmarker = null;
}

function ensureTaskCanvas(width, height, delegate) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const useGpu = delegate === "GPU";
  if (!useGpu) {
    state.taskCanvas = null;
    state.taskGl = null;
    return;
  }
  if (!state.taskCanvas || state.taskCanvas.width !== safeWidth || state.taskCanvas.height !== safeHeight) {
    state.taskCanvas = new OffscreenCanvas(safeWidth, safeHeight);
    state.taskGl = null;
  }
  if (!state.taskGl) {
    state.taskGl = state.taskCanvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
  }
  if (!state.taskGl) {
    state.taskCanvas = null;
    throw new Error("tracking GPU delegate requested but WebGL2 is unavailable in worker");
  }
}

function downgradeToCpuDelegate(reason) {
  if (state.config.delegate !== "GPU") return false;
  closeFaceLandmarker();
  state.taskCanvas = null;
  state.taskGl = null;
  state.config = {
    ...state.config,
    delegate: "CPU",
  };
  self.postMessage({
    type: "tracking-warning",
    warning: `GPU delegate unavailable, falling back to CPU: ${reason}`,
    delegate: state.config.delegate,
  });
  return true;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

function normalizeVec3(vec) {
  const length = Math.hypot(vec[0], vec[1], vec[2]);
  if (!(length > 1e-6)) return [0, 0, 0];
  return [vec[0] / length, vec[1] / length, vec[2] / length];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function rotationMatrixToQuaternion(r) {
  const trace = r[0][0] + r[1][1] + r[2][2];
  let x;
  let y;
  let z;
  let w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2.0;
    w = 0.25 * s;
    x = (r[2][1] - r[1][2]) / s;
    y = (r[0][2] - r[2][0]) / s;
    z = (r[1][0] - r[0][1]) / s;
  } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = Math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2.0;
    w = (r[2][1] - r[1][2]) / s;
    x = 0.25 * s;
    y = (r[0][1] + r[1][0]) / s;
    z = (r[0][2] + r[2][0]) / s;
  } else if (r[1][1] > r[2][2]) {
    const s = Math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2.0;
    w = (r[0][2] - r[2][0]) / s;
    x = (r[0][1] + r[1][0]) / s;
    y = 0.25 * s;
    z = (r[1][2] + r[2][1]) / s;
  } else {
    const s = Math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2.0;
    w = (r[1][0] - r[0][1]) / s;
    x = (r[0][2] + r[2][0]) / s;
    y = (r[1][2] + r[2][1]) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  if (!(n > 1e-6)) return [0, 0, 0, 1];
  return [x / n, y / n, z / n, w / n];
}

function rotationMatrixToEulerZxy(r) {
  const pitch = Math.asin(-r[1][2]);
  const yaw = Math.atan2(r[0][2], r[2][2]);
  const roll = Math.atan2(r[1][0], r[1][1]);
  const rad2deg = 180.0 / Math.PI;
  return { yaw: yaw * rad2deg, pitch: pitch * rad2deg, roll: roll * rad2deg };
}

function computeFixedRotationMatrix(landmarks) {
  const leftEye = landmarks[LEFT_EYE_OUTER];
  const rightEye = landmarks[RIGHT_EYE_OUTER];
  const chin = landmarks[CHIN];
  const nose = landmarks[NOSE_TIP];
  const zAxis = normalizeVec3(cross(sub(rightEye, leftEye), sub(chin, leftEye)));
  let xAxis = normalizeVec3(sub(rightEye, leftEye));
  const yAxis = normalizeVec3(cross(zAxis, xAxis));
  xAxis = normalizeVec3(cross(yAxis, zAxis));
  return {
    rotationMatrix: [
      [xAxis[0], yAxis[0], zAxis[0]],
      [xAxis[1], yAxis[1], zAxis[1]],
      [xAxis[2], yAxis[2], zAxis[2]],
    ],
    nose,
  };
}

function getGazeOffset(center, outer, inner, top, bottom) {
  let gazeX = 0;
  const eyeWidth = inner.x - outer.x;
  if (Math.abs(eyeWidth) > 1e-6) gazeX = ((center.x - outer.x) / eyeWidth) * 2.0 - 1.0;
  const middleY = (top.y + bottom.y) / 2.0;
  const halfHeight = (bottom.y - top.y) / 2.0;
  let gazeY = 0;
  if (Math.abs(halfHeight) > 1e-6) gazeY = (center.y - middleY) / halfHeight;
  return [clamp(gazeX, -1, 1), clamp(gazeY, -1, 1)];
}

function getGazeRight(landmarks) {
  return getGazeOffset(landmarks[RIGHT_IRIS_CENTER], landmarks[LEFT_EYE_OUTER], landmarks[RIGHT_EYE_INNER], landmarks[RIGHT_EYE_TOP], landmarks[RIGHT_EYE_BOTTOM]);
}

function getGazeLeft(landmarks) {
  return getGazeOffset(landmarks[LEFT_IRIS_CENTER], landmarks[LEFT_EYE_OUTER_MP], landmarks[LEFT_EYE_INNER_MP], landmarks[LEFT_EYE_TOP], landmarks[LEFT_EYE_BOTTOM]);
}

function convertBlendshapes(faceBlendshapes) {
  const out = Object.create(null);
  const categories = Array.isArray(faceBlendshapes?.categories)
    ? faceBlendshapes.categories
    : (Array.isArray(faceBlendshapes) ? faceBlendshapes : []);
  for (const item of categories) {
    const name = String(item.categoryName || item.category_name || "");
    if (!name) continue;
    out[name] = Number(item.score) || 0;
  }
  return out;
}

function swapLeftRightName(name) {
  const text = String(name || "");
  if (!text) return text;
  return text
    .replace(/Left/g, "__TMP_LEFT__")
    .replace(/Right/g, "Left")
    .replace(/__TMP_LEFT__/g, "Right")
    .replace(/left/g, "__tmp_left__")
    .replace(/right/g, "left")
    .replace(/__tmp_left__/g, "right");
}

function mirrorBlendshapes(blendshapes) {
  const source = blendshapes && typeof blendshapes === "object" ? blendshapes : Object.create(null);
  const mirrored = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    mirrored[swapLeftRightName(name)] = value;
  }
  const gazeRightX = Number(source.GazeRightX ?? 0);
  const gazeRightY = Number(source.GazeRightY ?? 0);
  const gazeLeftX = Number(source.GazeLeftX ?? 0);
  const gazeLeftY = Number(source.GazeLeftY ?? 0);
  mirrored.GazeRightX = -gazeLeftX;
  mirrored.GazeRightY = gazeLeftY;
  mirrored.GazeLeftX = -gazeRightX;
  mirrored.GazeLeftY = gazeRightY;
  return mirrored;
}

function shouldMirrorTrackingOutput() {
  return !!state.config.flipX !== !!state.config.invertHorizontal;
}

function buildTrackingFrame(result) {
  if (!result?.faceLandmarks?.length) {
    return { hasFocus: false, reason: "no-face", blendshapes: Object.create(null), bones: Object.create(null) };
  }
  const landmarks = result.faceLandmarks[0];
  const triplets = landmarks.map((lm) => [Number(lm.x) || 0, Number(lm.y) || 0, Number(lm.z) || 0]);
  const { rotationMatrix } = computeFixedRotationMatrix(triplets);
  const quat = rotationMatrixToQuaternion(rotationMatrix);
  const euler = rotationMatrixToEulerZxy(rotationMatrix);
  euler.yaw = -euler.yaw;
  const rightGaze = getGazeRight(landmarks);
  const leftGaze = getGazeLeft(landmarks);
  const nose = landmarks[NOSE_TIP];
  let blendshapes = convertBlendshapes(result.faceBlendshapes?.[0]);
  blendshapes.GazeRightX = rightGaze[0];
  blendshapes.GazeRightY = rightGaze[1];
  blendshapes.GazeLeftX = leftGaze[0];
  blendshapes.GazeLeftY = leftGaze[1];
  if (shouldMirrorTrackingOutput()) {
    if (nose) {
      nose.x = 1.0 - Number(nose.x || 0);
    }
    euler.yaw = -euler.yaw;
    euler.roll = -euler.roll;
    blendshapes = mirrorBlendshapes(blendshapes);
  }
  return {
    hasFocus: true,
    reason: "ok",
    blendshapes,
    bones: {
      Head: {
        position: { x: Number(nose?.x || 0), y: Number(nose?.y || 0), z: Number(nose?.z || 0) },
        rotation: { roll: euler.roll, pitch: euler.pitch, yaw: euler.yaw },
        quaternion: { x: quat[0], y: quat[1], z: quat[2], w: quat[3] },
      },
    },
  };
}

async function ensureFaceLandmarker() {
  if (state.faceLandmarker) return state.faceLandmarker;
  const { FaceLandmarker, FilesetResolver } = await ensureTasksVisionLoaded();
  const vision = await FilesetResolver.forVisionTasks(state.config.wasmPath);
  for (;;) {
    const options = {
      baseOptions: {
        modelAssetPath: state.config.modelAssetPath,
        delegate: state.config.delegate,
      },
      outputFaceBlendshapes: true,
      runningMode: state.config.runningMode,
      numFaces: state.config.numFaces,
    };
    if (state.config.delegate === "GPU") {
      if (!state.taskCanvas) {
        throw new Error("tracking GPU delegate requested before task canvas initialization");
      }
      options.canvas = state.taskCanvas;
    }
    try {
      state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
      return state.faceLandmarker;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!downgradeToCpuDelegate(message)) {
        throw error;
      }
    }
  }
}

self.onmessage = async (event) => {
  const data = event?.data || {};
  if (data.type === "bind-evaluator-port") {
    const [port] = event.ports || [];
    state.evaluatorPort = port || null;
    state.evaluatorPort?.start?.();
    return;
  }
  if (data.type === "config") {
    const nextConfig = {
      ...state.config,
      ...(data.config && typeof data.config === "object" ? data.config : {}),
    };
    const requiresRecreate =
      nextConfig.wasmPath !== state.config.wasmPath ||
      nextConfig.modelAssetPath !== state.config.modelAssetPath ||
      nextConfig.delegate !== state.config.delegate ||
      nextConfig.runningMode !== state.config.runningMode ||
      nextConfig.numFaces !== state.config.numFaces;
    state.config = {
      ...nextConfig,
    };
    if (requiresRecreate) {
      closeFaceLandmarker();
    }
    self.postMessage({ type: "tracking-ready", delegate: state.config.delegate });
    return;
  }
  const inputFrame = data.videoFrame || data.bitmap || null;
  if (data.type !== "frame" || !inputFrame) return;
  try {
    const width = inputFrame.displayWidth || inputFrame.codedWidth || inputFrame.width || 0;
    const height = inputFrame.displayHeight || inputFrame.codedHeight || inputFrame.height || 0;
    try {
      ensureTaskCanvas(width, height, state.config.delegate);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!downgradeToCpuDelegate(message)) {
        throw error;
      }
    }
    const landmarker = await ensureFaceLandmarker();
    const result = landmarker.detectForVideo(inputFrame, Number(data.timestampMs) || performance.now());
    const frame = buildTrackingFrame(result);
    const seq = Number(data.seq) || 0;
    const timestampMs = Number(data.timestampMs) || performance.now();
    state.evaluatorPort?.postMessage({
      type: "frame",
      seq,
      timestampMs,
      frame,
    });
    self.postMessage({
      type: "tracking-status",
      seq,
      timestampMs,
      status: buildTrackingStatus(frame),
    });
  } catch (error) {
    self.postMessage({ type: "tracking-error", error: String(error && error.message ? error.message : error) });
  } finally {
    try { inputFrame.close?.(); } catch (_) {}
  }
};
