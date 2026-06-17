/*
Readable extraction of LibTV's GLB pose conversion logic.

Observed source chunks:
- 0xt0.f_qe60y6.js: semantic bone aliases, bind-pose quaternion delta logic.
- 0-u6zq1hd-j1t.js: default joint angles and -90 degree GLB facing correction.

This file is not an official LibTV source file. It is a clean, readable helper
that mirrors the runtime behavior seen in the bundled frontend.
*/

export const GLB_CHARACTER_MODEL_Y_CORRECTION_DEG = -90;

export const DEFAULT_JOINT_ANGLES = {
  body: { bend: 0, turn: 0, tilt: 0 },
  torso: { bend: 2, turn: 0, tilt: 0 },
  head: { nod: -10, turn: 0, tilt: 0 },
  l_arm: { raise: -5, straddle: 7, turn: 0 },
  r_arm: { raise: -5, straddle: 7, turn: 0 },
  l_elbow: { bend: 15 },
  r_elbow: { bend: 15 },
  l_leg: { raise: 0, straddle: 0, turn: 0 },
  r_leg: { raise: 0, straddle: 0, turn: 0 },
  l_knee: { bend: 0 },
  r_knee: { bend: 0 },
};

export const BONE_ALIASES = {
  body: ["hips", "pelvis", "hip", "root"],
  torso: ["upperchest", "chest", "spine2", "spine1", "spine"],
  head: ["head"],
  l_arm: ["leftupperarm", "leftarm", "lupperarm", "larm", "upperarml", "arml"],
  r_arm: ["rightupperarm", "rightarm", "rupperarm", "rarm", "upperarmr", "armr"],
  l_elbow: ["leftforearm", "leftlowerarm", "lforearm", "llowerarm", "forearml", "lowerarml"],
  r_elbow: ["rightforearm", "rightlowerarm", "rforearm", "rlowerarm", "forearmr", "lowerarmr"],
  l_leg: ["leftupleg", "leftupperleg", "leftthigh", "lupleg", "lupperleg", "lthigh", "uplegl", "upperlegl", "thighl"],
  r_leg: ["rightupleg", "rightupperleg", "rightthigh", "rupleg", "rupperleg", "rthigh", "uplegr", "upperlegr", "thighr"],
  l_knee: ["leftleg", "leftlowerleg", "leftcalf", "lleg", "llowerleg", "lcalf", "legl", "lowerlegl", "calfl"],
  r_knee: ["rightleg", "rightlowerleg", "rightcalf", "rleg", "rlowerleg", "rcalf", "legr", "lowerlegr", "calfr"],
};

export function normalizeBoneName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collectBones(root) {
  const bones = [];
  root.traverse((node) => {
    if (node.isBone || node.type === "Bone") bones.push(node);
  });
  return bones;
}

export function mapLiblibSemanticBones(root) {
  const bones = collectBones(root);
  const mapped = {};

  for (const [semanticName, aliases] of Object.entries(BONE_ALIASES)) {
    mapped[semanticName] =
      bones.find((bone) => aliases.some((alias) => normalizeBoneName(bone.name) === alias)) ||
      bones.find((bone) => aliases.some((alias) => normalizeBoneName(bone.name).includes(alias))) ||
      null;
  }

  return mapped;
}

export function buildLiblibGlbRig(root) {
  const bones = mapLiblibSemanticBones(root);
  const bindQuaternions = new Map();

  for (const bone of Object.values(bones)) {
    if (bone) bindQuaternions.set(bone.uuid, bone.quaternion.clone());
  }

  return { bones, bindQuaternions };
}

function copyPart(inputPart, defaultPart, keys, state) {
  const out = { ...defaultPart };
  if (!inputPart || typeof inputPart !== "object" || Array.isArray(inputPart)) return out;

  for (const key of keys) {
    const value = inputPart[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
      state.hasValue = true;
    }
  }

  return out;
}

export function normalizeJointAngles(input, defaults = DEFAULT_JOINT_ANGLES) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const state = { hasValue: false };
  const normalized = {
    body: copyPart(input.body, defaults.body, ["bend", "turn", "tilt"], state),
    torso: copyPart(input.torso, defaults.torso, ["bend", "turn", "tilt"], state),
    head: copyPart(input.head, defaults.head, ["nod", "turn", "tilt"], state),
    l_arm: copyPart(input.l_arm, defaults.l_arm, ["raise", "straddle", "turn"], state),
    r_arm: copyPart(input.r_arm, defaults.r_arm, ["raise", "straddle", "turn"], state),
    l_elbow: copyPart(input.l_elbow, defaults.l_elbow, ["bend"], state),
    r_elbow: copyPart(input.r_elbow, defaults.r_elbow, ["bend"], state),
    l_leg: copyPart(input.l_leg, defaults.l_leg, ["raise", "straddle", "turn"], state),
    r_leg: copyPart(input.r_leg, defaults.r_leg, ["raise", "straddle", "turn"], state),
    l_knee: copyPart(input.l_knee, defaults.l_knee, ["bend"], state),
    r_knee: copyPart(input.r_knee, defaults.r_knee, ["bend"], state),
  };

  return state.hasValue ? normalized : null;
}

function applyBoneDelta(THREE, rig, semanticName, eulerBeforeLiblibNegation) {
  const bone = rig.bones[semanticName];
  if (!bone) return false;

  const bindQuaternion = rig.bindQuaternions.get(bone.uuid);
  if (!bindQuaternion) return false;

  const e = eulerBeforeLiblibNegation;
  const deltaEuler = new THREE.Euler(-e.x, -e.y, -e.z, e.order);
  const deltaQuaternion = new THREE.Quaternion().setFromEuler(deltaEuler);

  bone.quaternion.copy(bindQuaternion).multiply(deltaQuaternion);
  return true;
}

export function applyLiblibJointAnglesToRig(THREE, rig, jointAngles) {
  const deg = Math.PI / 180;
  const j = normalizeJointAngles(jointAngles) || DEFAULT_JOINT_ANGLES;
  const set = (name, x, y, z, order = "XYZ") =>
    applyBoneDelta(THREE, rig, name, new THREE.Euler(x, y, z, order));

  set("body", j.body.bend * deg, j.body.turn * deg, j.body.tilt * deg, "YXZ");
  set("torso", j.torso.bend * deg, j.torso.turn * deg, j.torso.tilt * deg, "YXZ");
  set("head", j.head.nod * deg, j.head.turn * deg, j.head.tilt * deg, "YXZ");

  set("l_arm", -j.l_arm.raise * deg, j.l_arm.turn * deg, -j.l_arm.straddle * deg, "ZXY");
  set("r_arm", -j.r_arm.raise * deg, -j.r_arm.turn * deg, j.r_arm.straddle * deg, "ZXY");
  set("l_elbow", -j.l_elbow.bend * deg, 0, 0);
  set("r_elbow", -j.r_elbow.bend * deg, 0, 0);

  set("l_leg", -j.l_leg.raise * deg, j.l_leg.turn * deg, -j.l_leg.straddle * deg, "ZXY");
  set("r_leg", -j.r_leg.raise * deg, -j.r_leg.turn * deg, j.r_leg.straddle * deg, "ZXY");
  set("l_knee", j.l_knee.bend * deg, 0, 0);
  set("r_knee", j.r_knee.bend * deg, 0, 0);

  return true;
}

export function applyLiblibJointAnglesToRoot(THREE, root, jointAngles, existingRig = null) {
  const rig = existingRig || buildLiblibGlbRig(root);
  applyLiblibJointAnglesToRig(THREE, rig, jointAngles);
  return rig;
}

export function normalizeLiblibGlbCharacter(THREE, root, options = {}) {
  const {
    autoScale = true,
    targetHeight = 1.75,
    yCorrectionDeg = GLB_CHARACTER_MODEL_Y_CORRECTION_DEG,
  } = options;

  root.updateMatrixWorld(true);

  if (autoScale) {
    const height = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y || 1;
    root.scale.multiplyScalar(targetHeight / height);
    root.updateMatrixWorld(true);
  }

  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.rotation.y = yCorrectionDeg * Math.PI / 180;
  root.updateMatrixWorld(true);

  return root;
}
