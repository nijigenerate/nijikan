if (!self.__mediapipeTasksVision) {
  self.exports = self.exports || {};
  self.module = self.module || { exports: self.exports };
  importScripts("/vendor/package/vision_bundle.cjs");
  self.__mediapipeTasksVision = self.module?.exports || self.exports;
}

const { FaceLandmarker, FilesetResolver } = self.__mediapipeTasksVision;

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
  canvas: null,
  ctx: null,
  config: {
    runningMode: "VIDEO",
    wasmPath: "/vendor/package/wasm",
    modelAssetPath: "/tracking/face_landmarker_v2_with_blendshapes.task",
    numFaces: 1,
    flipX: true,
    invertHorizontal: false,
  },
};

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
  for (const item of Array.isArray(faceBlendshapes) ? faceBlendshapes : []) {
    const name = String(item.categoryName || item.category_name || "");
    if (!name) continue;
    out[name] = Number(item.score) || 0;
  }
  return out;
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
  const rightGaze = getGazeRight(landmarks);
  const leftGaze = getGazeLeft(landmarks);
  const blendshapes = convertBlendshapes(result.faceBlendshapes?.[0]);
  if (state.config.invertHorizontal) {
    euler.yaw = -euler.yaw;
    rightGaze[0] = -rightGaze[0];
    leftGaze[0] = -leftGaze[0];
  }
  blendshapes.GazeRightX = rightGaze[0];
  blendshapes.GazeRightY = rightGaze[1];
  blendshapes.GazeLeftX = leftGaze[0];
  blendshapes.GazeLeftY = leftGaze[1];
  const nose = landmarks[NOSE_TIP];
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
  const vision = await FilesetResolver.forVisionTasks(state.config.wasmPath);
  state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: state.config.modelAssetPath },
    outputFaceBlendshapes: true,
    runningMode: state.config.runningMode,
    numFaces: state.config.numFaces,
  });
  return state.faceLandmarker;
}

self.onmessage = async (event) => {
  const data = event?.data || {};
  if (data.type === "config") {
    state.config = {
      ...state.config,
      ...(data.config && typeof data.config === "object" ? data.config : {}),
    };
    self.postMessage({ type: "tracking-ready" });
    return;
  }
  if (data.type !== "frame" || !data.bitmap) return;
  try {
    const landmarker = await ensureFaceLandmarker();
    const bitmap = data.bitmap;
    const width = bitmap.width || 0;
    const height = bitmap.height || 0;
    if (!state.canvas || state.canvas.width !== width || state.canvas.height !== height) {
      state.canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
      state.ctx = state.canvas.getContext("2d");
    }
    state.ctx.save();
    state.ctx.clearRect(0, 0, width, height);
    if (state.config.flipX) {
      state.ctx.translate(width, 0);
      state.ctx.scale(-1, 1);
    }
    state.ctx.drawImage(bitmap, 0, 0, width, height);
    state.ctx.restore();
    const result = landmarker.detectForVideo(state.canvas, Number(data.timestampMs) || performance.now());
    self.postMessage({ type: "tracking", seq: Number(data.seq) || 0, frame: buildTrackingFrame(result) });
  } catch (error) {
    self.postMessage({ type: "tracking-error", error: String(error && error.message ? error.message : error) });
  } finally {
    try { data.bitmap.close?.(); } catch (_) {}
  }
};
