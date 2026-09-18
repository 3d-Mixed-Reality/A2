// MAC0623 — A2 Docking Testbed (Desktop + VR)
//
// Mesmo codigo do meu A1 (lab06) com o modo VR adicionado por cima.
// A logica de trial, tolerancia, erro e CSV NAO mudou — o que entrou foi:
//   - o bootstrap WebXR (renderer.xr + VRButton + controllers) no main()
//   - o render loop virou renderer.setAnimationLoop (obrigatorio pro WebXR)
//   - tres condicoes VR no updateControlMapping: grab, trackball e gizmo
//   - uma coluna vr_experience no CSV
// Tudo que e VR fica entre os blocos // ===== VR ===== ... // ===== END VR =====

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";

// ---------------------------------------------------------------------------
// Module-scope state — provided
//
// Populated once, by main() (via buildScene() for scene/cube/target), before
// any trial starts or any frame renders. Everything below this point —
// generateTargetPose(), checkTolerance(), updateControlMapping(), animate()
// — reads and writes these directly, the same way it would if they were
// still declared inline where they're first used.
// ---------------------------------------------------------------------------

let scene, camera, renderer, cube, target;
let player; // grupo que carrega a camera e os controles (ver main())

/**
 * buildScene()
 *
 * Builds the static contents of the 3D scene: background color, lighting,
 * the reference grid/axes, the student-controlled cube, and the translucent
 * target mesh (the goal pose). Does not create the camera or renderer —
 * that's main()'s job — and does not start the render loop.
 *
 * Pure with respect to the rest of the app: it only touches the THREE.Scene
 * it creates and returns, so it's safe to read top-to-bottom on its own.
 *
 * @returns {{ scene: THREE.Scene, cube: THREE.Mesh, target: THREE.Mesh }}
 *   The new scene, plus direct references to the two meshes the rest of the
 *   app needs: `cube` (control mappings write to `cube.position` /
 *   `cube.quaternion`) and `target` (`generateTargetPose()` writes to it
 *   every trial).
 */
function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2, 4, 3);
  scene.add(dirLight);

  scene.add(new THREE.GridHelper(6, 24, 0x444444, 0x2a2a2a));
  scene.add(new THREE.AxesHelper(0.6));

  // Cube (student-controlled) and target (goal pose) share one geometry —
  // the target clones it so the two meshes can have independent materials
  // (opaque vs. translucent) without sharing a single Mesh instance.
  const cubeGeometry = new THREE.BoxGeometry(0.4, 0.4, 0.4);

  const cube = new THREE.Mesh(
    cubeGeometry,
    new THREE.MeshStandardMaterial({ color: 0x3d8bfd })
  );
  cube.position.set(0, 0.5, 0);
  scene.add(cube);

  const target = new THREE.Mesh(
    cubeGeometry.clone(),
    new THREE.MeshStandardMaterial({
      color: 0x2ecc71,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    })
  );
  scene.add(target);

  return { scene, cube, target };
}

/**
 * main()
 *
 * Entry point for the whole app. Order matters here:
 *   1. Build the scene (`buildScene()`) — cube and target must exist before
 *      anything below tries to read their position/quaternion.
 *   2. Create the camera and renderer, and wire the window resize handler.
 *   3. WebXR bootstrap (renderer.xr, VRButton, controllers).
 *   4. Start the trial state machine (`startTrial()`), which generates the
 *      first target pose.
 *   5. Start the render loop (`renderer.setAnimationLoop(animate)`).
 *
 * Called once, at the bottom of this file. Everything it sets up
 * (`scene`, `camera`, `renderer`, `cube`, `target`) is written into the
 * module-scope variables declared above, so the rest of the file can keep
 * referring to them as plain names instead of threading them through every
 * function call.
 */
function main() {
  ({ scene, cube, target } = buildScene());

  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.05,
    100
  );

  // em VR a camera do headset fica na origem do reference space, entao pra
  // colocar o usuario um pouco atras da area de trabalho eu ponho a camera
  // (e os controles) dentro de um grupo e desloco o grupo. no desktop a
  // camera continua no mesmo lugar do A1 (0, 1.4, 4) olhando pro (0, 0.5, 0)
  player = new THREE.Group();
  player.position.set(0, 0, PLAYER_Z);
  player.add(camera);
  scene.add(player);
  camera.position.set(0, 1.4, 4 - PLAYER_Z);
  player.updateMatrixWorld(true); // lookAt precisa do matrixWorld atualizado
  camera.lookAt(0, 0.5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // ===== VR =====
  // as 5 linhas do lab08/lab10: liga o xr, botao "Enter VR", controles
  renderer.xr.enabled = true;
  document.body.appendChild(VRButton.createButton(renderer));
  setupControllers();
  buildGizmo();
  buildVrHud();
  // se sair do VR no meio de uma acao, solta tudo
  renderer.xr.addEventListener("sessionstart", releaseVrAction);
  renderer.xr.addEventListener("sessionend", releaseVrAction);
  // ===== END VR =====

  window.addEventListener("resize", handleWindowResize);

  startTrial();
  renderer.setAnimationLoop(animate);
}

/**
 * handleWindowResize()
 *
 * Keeps the camera's aspect ratio and the renderer's output size in sync
 * with the browser window. Registered as the "resize" listener in main().
 */
function handleWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// Target-pose generation — provided
//
// Uses Shoemake's algorithm for a uniformly-random unit quaternion (uniform
// over SO(3)), rather than converting random Euler angles, which would bias
// the sampled orientations. Position is uniform within a bounding box in
// front of the camera.
// ---------------------------------------------------------------------------

function randomQuaternionShoemake() {
  const u1 = Math.random();
  const u2 = Math.random();
  const u3 = Math.random();

  const sqrt1MinusU1 = Math.sqrt(1 - u1);
  const sqrtU1 = Math.sqrt(u1);

  const theta1 = 2 * Math.PI * u2;
  const theta2 = 2 * Math.PI * u3;

  return new THREE.Quaternion(
    sqrt1MinusU1 * Math.sin(theta1),
    sqrt1MinusU1 * Math.cos(theta1),
    sqrtU1 * Math.sin(theta2),
    sqrtU1 * Math.cos(theta2)
  );
}

const TARGET_BOUNDS = {
  x: [-1.0, 1.0],
  y: [0.2, 1.6],
  z: [-0.6, 0.6],
};

function randomInRange([min, max]) {
  return min + Math.random() * (max - min);
}

function generateTargetPose() {
  target.position.set(
    randomInRange(TARGET_BOUNDS.x),
    randomInRange(TARGET_BOUNDS.y),
    randomInRange(TARGET_BOUNDS.z)
  );
  target.quaternion.copy(randomQuaternionShoemake());
}

// ---------------------------------------------------------------------------
// Tolerance check — provided
//
// Position tolerance: 0.05 units (world units == meters, at this scene
// scale). Orientation tolerance: 10 degrees, measured via
// Quaternion.angleTo(), which is robust to double-cover (q and -q represent
// the same rotation) — do not compute orientation error from Euler angles.
//
// UMA constante pra todos os modos (desktop e as 3 condicoes VR) — regra do A2.
// ---------------------------------------------------------------------------

const POSITION_TOLERANCE = 0.05;
const ORIENTATION_TOLERANCE_DEG = 10;

function checkTolerance() {
  const positionError = cube.position.distanceTo(target.position);
  const orientationErrorRad = cube.quaternion.angleTo(target.quaternion);
  const orientationErrorDeg = THREE.MathUtils.radToDeg(orientationErrorRad);

  const withinTolerance =
    positionError <= POSITION_TOLERANCE &&
    orientationErrorDeg <= ORIENTATION_TOLERANCE_DEG;

  return { positionError, orientationErrorDeg, withinTolerance };
}

// ---------------------------------------------------------------------------
// HUD references — provided
// ---------------------------------------------------------------------------

const participantIdInput = document.getElementById("participantId");
const mappingSelect = document.getElementById("mappingSelect");
const vrExperienceSelect = document.getElementById("vrExperience");
const trialCountEl = document.getElementById("trialCount");
const confirmBtn = document.getElementById("confirmBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------------------:
// Trial state machine — provided
//
// presentation_order counts trials within the *current* mapping selection
// since the page loaded — it does not reset when you switch mapping in the
// dropdown mid-session, since order-of-presentation across mappings is part
// of what you're counterbalancing across participants (see A1's ABBA
// counterbalancing note). trial_number is a simple running counter of every
// trial confirmed this session, regardless of mapping.
// ---------------------------------------------------------------------------

let trialNumber = 0;
let presentationOrderByMapping = {}; // chave = valor do select (desktop-1, vr-grab, ...)
let trialStartTime = performance.now();
let pathLength = 0; // accumulated cube-position travel distance this trial
// Placeholder — cube doesn't exist yet at module-load time (main() creates
// it via buildScene()). startTrial() calls lastCubePosition.copy(cube.position)
// before this value is ever read, so the zero vector here is never used.
let lastCubePosition = new THREE.Vector3();

// ===== STUDENT TODO =====
// Increment this from your own mapping code every time the user switches
// input mode (e.g. toggling translate/rotate mode in the baseline mapping).
// It is read (and reset) when a trial is confirmed.
let modeSwitches = 0;
let isRotating = false; // true when in rotation mode (Space/Tab toggles it)
let mouseX = 0; let mouseY = 0;
const TRANSLATE_SPEED = 0.002;

const ROTATE_SPEED = 0.005; 
// my state for the drag stuff
let isLeftDown = false, isRightDown = false, cubeSelected = false;
let moveDX = 0, moveDY = 0; // mouse deltas accumulated since last frame
let wheelDY = 0;            // scroll accumulated since last frame
let raycaster = new THREE.Raycaster();
let mouseNDC = new THREE.Vector2();
let dragPlane = new THREE.Plane();
let dragOffset = new THREE.Vector3();
let dragIntersect = new THREE.Vector3();
let arrowDir = 0; // +1 up, -1 down, 0 none

window.addEventListener("mousemove", (e) => {
  mouseX = e.clientX; mouseY = e.clientY;
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  moveDX += e.movementX;
  moveDY += e.movementY;
}); //importatn for the baseline mapping to track mouse movement

// check if the click was on the cube (raycaster)
window.addEventListener('mousedown', (e) => {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  if (camera && cube) {
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObject(cube);
    cubeSelected = hits.length > 0;
    if (cubeSelected && e.button === 0) {
      // plane parallel to the camera going thru the cube
      dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(dragPlane.normal), cube.position);
      if (raycaster.ray.intersectPlane(dragPlane, dragIntersect)) {
        dragOffset.copy(dragIntersect).sub(cube.position);
      }
    }
  }
  if (e.button === 0) isLeftDown = true;
  if (e.button === 2) isRightDown = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { isLeftDown = false; cubeSelected = false; }
  if (e.button === 2) isRightDown = false;
});
window.addEventListener('contextmenu', e => e.preventDefault()); // so right click doesnt open the menu
window.addEventListener('wheel', (e) => {
  if (!camera || !cube) return;
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  if (raycaster.intersectObject(cube).length > 0) wheelDY += e.deltaY; // so em cima do cubo
}, {passive:true});


function handleKeydown(e) {
  if (e.key === "Enter") confirmTrial();
  if (e.code === "Tab" || e.code === "Space") {
    e.preventDefault(); // prevent browser focus change
    // only mapping desktop-1 has modes, desktop-2 must stay with mode_switches = 0
    if (currentMapping() === "desktop-1") switchMode();
  }
  // arrows for roll
  if (e.key === "ArrowUp") arrowDir = 1;
  if (e.key === "ArrowDown") arrowDir = -1;
}
window.addEventListener('keyup', (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") arrowDir = 0;
});
// ===== END STUDENT TODO =====

// ===== VR =====
// Estado e helpers das condicoes VR. Os handlers de trigger (onSelectStart /
// onSelectEnd) so decidem o que comecar; quem move o cubo de fato e o
// updateVr(), chamado a cada frame pelo updateControlMapping().
//
// Convencao de maos: a mao DIREITA manipula o cubo e a ESQUERDA confirma o
// trial (trigger = Enter). Se o dispositivo nao informar handedness (alguns
// perfis do emulador), controle 0 manipula e controle 1 confirma.
// Uso a pose de "target ray" (renderer.xr.getController) e nao a de grip, porque
// as tres condicoes precisam apontar (raycast) e assim o cubo gruda no mesmo
// frame de onde o raio sai.

const PLAYER_Z = 1.6; // quanto o usuario comeca atras da origem (metros).
// os alvos vao ate z = +0.6, entao com menos que ~1.2 o alvo pode nascer do lado
// ou atras da cabeca; 1.6 deixa tudo na frente e ainda da pra apontar (o grab e por raio)

let controllers = [];   // os dois XRTargetRaySpace, indice = renderer.xr.getController(i)
let vrAction = null;    // o que a mao de manipulacao esta fazendo agora (null = nada)
let vrLastKind = null;  // "translate" | "rotate" da ultima acao, pra contar mode switches

// temporarios reaproveitados pra nao alocar todo frame
const _vrRaycaster = new THREE.Raycaster();
const _tmpMat = new THREE.Matrix4();
const _tmpMat2 = new THREE.Matrix4();
const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();

function setupControllers() {
  const modelFactory = new XRControllerModelFactory();
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    controller.userData.index = i;
    controller.userData.handedness = null;
    controller.addEventListener("connected", (e) => {
      controller.userData.handedness = e.data.handedness; // "left" | "right" | "none"
    });
    controller.addEventListener("disconnected", () => {
      controller.userData.handedness = null;
    });
    controller.addEventListener("selectstart", onSelectStart);
    controller.addEventListener("selectend", onSelectEnd);

    // linha do raio, pra ver pra onde o controle esta apontando
    const rayGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const ray = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ color: 0xffffff }));
    ray.scale.z = 3;
    controller.add(ray);
    player.add(controller);

    // modelo 3D do controle (grip pose), so visual
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(modelFactory.createControllerModel(grip));
    player.add(grip);

    controllers.push(controller);
  }
}

function isConfirmHand(controller) {
  const h = controller.userData.handedness;
  if (h === "left") return true;
  if (h === "right") return false;
  return controller.userData.index === 1; // sem handedness: controle 1 confirma
}

function manipulationController() {
  return controllers.find((c) => !isConfirmHand(c)) || controllers[0];
}

// raycaster saindo do controle na direcao -Z dele
function setRayFromController(controller) {
  _tmpMat.identity().extractRotation(controller.matrixWorld);
  _vrRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  _vrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(_tmpMat);
}

function getIntersections(controller, objects, recursive = false) {
  setRayFromController(controller);
  return _vrRaycaster.intersectObjects(objects, recursive);
}

// onde o raio do controle fura um plano (null se for paralelo)
function rayPlaneHit(controller, plane, out) {
  setRayFromController(controller);
  return _vrRaycaster.ray.intersectPlane(plane, out);
}

function onSelectStart(event) {
  const controller = event.target;
  const mapping = currentMapping();
  if (!mapping.startsWith("vr")) return; // no desktop o trigger nao faz nada
  if (isConfirmHand(controller)) { confirmTrial(); return; }
  if (vrAction) return; // ja esta segurando algo
  // os controles so atualizam o matrixWorld no render, entao forca aqui pra
  // usar a pose atual e nao a do frame passado
  controller.updateMatrixWorld(true);
  cube.updateMatrixWorld(true);
  if (mapping === "vr-grab") grabStart(controller);
  else if (mapping === "vr-trackball") trackballStart(controller);
  else if (mapping === "vr-gizmo") gizmoStart(controller);
}

function onSelectEnd(event) {
  if (vrAction && vrAction.controller === event.target) releaseVrAction();
}

function releaseVrAction() {
  vrAction = null;
}

// conta troca de modo quando a mao alterna entre transladar e rotacionar
// (mesma semantica do Space/Tab no desktop-1). no grab nunca e chamado -> 0
function countVrModeSwitch(kind) {
  if (vrLastKind !== null && vrLastKind !== kind) modeSwitches += 1;
  vrLastKind = kind;
}

// --- 1. direct grab: 6DoF isomorfico ---------------------------------------
//
// Nao uso controller.attach(cube) de proposito: o checkTolerance() e o
// pathLength leem cube.position como coordenada de MUNDO, e se o cubo virasse
// filho do controle isso passava a ser coordenada local e quebrava a
// comparacao. Entao guardo a pose do cubo no frame do controle no momento do
// grab e recomponho a pose de mundo a cada frame — da no mesmo que o attach,
// mas o cubo continua filho da cena.

function grabStart(controller) {
  if (getIntersections(controller, [cube]).length === 0) return;
  const local = new THREE.Matrix4()
    .copy(controller.matrixWorld).invert()
    .multiply(cube.matrixWorld);
  vrAction = { type: "grab", controller, local };
}

function updateGrab() {
  _tmpMat.multiplyMatrices(vrAction.controller.matrixWorld, vrAction.local);
  _tmpMat.decompose(cube.position, cube.quaternion, _tmpScale); // escala fica 1, ignoro
}

// --- 2. VR trackball: rotacao indireta com ganho ----------------------------
//
// Apontando pro cubo + trigger  -> translacao direta (so posicao, sem girar)
// Apontando pro nada + trigger  -> "trackball": o delta de rotacao do controle
//                                  desde o inicio do aperto vai pro cubo com ganho
//
// TRACKBALL_GAIN = 2.0. Justificativa: o punho gira confortavelmente uns +-90
// graus (prono/supinacao) sem mexer o ombro, mas os alvos sao uniformes em
// SO(3), entao o erro inicial chega a 180 graus. Com ganho 2 um giro de punho
// cobre o espaco inteiro numa aperto so; pra ajuste fino da pra soltar e
// apertar de novo (clutch), ja que o delta e sempre relativo ao inicio do aperto.
// Ganho 1 obrigava a girar o braco todo; ganho 3+ ficou nervoso demais pra
// entrar nos 10 graus de tolerancia.

const TRACKBALL_GAIN = 2.0;

function trackballStart(controller) {
  if (getIntersections(controller, [cube]).length > 0) {
    const offset = cube.position.clone().sub(controller.getWorldPosition(_tmpVec));
    vrAction = { type: "translate", controller, offset };
    countVrModeSwitch("translate");
  } else {
    vrAction = {
      type: "rotate",
      controller,
      handQStart: controller.getWorldQuaternion(new THREE.Quaternion()),
      cubeQStart: cube.quaternion.clone(),
    };
    countVrModeSwitch("rotate");
  }
}

// multiplica o angulo de um quaternion por `gain` mantendo o eixo
function scaleQuaternion(q, gain) {
  if (q.w < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; } // caminho curto
  const halfAngle = Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
  const s = Math.sin(halfAngle);
  if (s < 1e-6) return q.identity();
  _tmpVec.set(q.x / s, q.y / s, q.z / s);
  return q.setFromAxisAngle(_tmpVec, 2 * halfAngle * gain);
}

function updateTrackball() {
  const { controller } = vrAction;
  if (vrAction.type === "translate") {
    cube.position.copy(controller.getWorldPosition(_tmpVec)).add(vrAction.offset);
  } else {
    // delta = qNow * inv(qStart), no frame do mundo
    controller.getWorldQuaternion(_tmpQuat);
    _tmpQuat.multiply(vrAction.handQStart.clone().invert());
    scaleQuaternion(_tmpQuat, TRACKBALL_GAIN);
    cube.quaternion.copy(_tmpQuat).multiply(vrAction.cubeQStart);
  }
}

// --- 3. VR gizmo: handles por eixo, drag restrito ---------------------------
//
// Tres setas (translacao em X/Y/Z) e tres aneis (rotacao em torno de X/Y/Z),
// alinhados com os eixos do MUNDO (como o TransformControls em space="world"),
// seguindo a posicao do cubo. Aponta o controle pro handle, aperta o trigger e
// ate soltar so aquele eixo conta:
//   seta -> projeta o deslocamento da mao no eixo, o resto e descartado
//   anel -> angulo entre onde o raio furava o plano do anel no inicio e agora

const GIZMO_ARROW_LEN = 0.8;    // setas bem pra fora do cubo (cubo tem 0.2 de meia-aresta)
const GIZMO_RING_RADIUS = 0.6;
const GIZMO_THICKNESS = 0.04;   // raio do tubo das setas/aneis — grosso pra ser facil de apontar
const GIZMO_AXES = [
  { axis: new THREE.Vector3(1, 0, 0), color: 0xff4444 },
  { axis: new THREE.Vector3(0, 1, 0), color: 0x44ff44 },
  { axis: new THREE.Vector3(0, 0, 1), color: 0x4488ff },
];

let gizmo;              // THREE.Group, filho da cena, segue cube.position
let gizmoHandles = [];  // meshes raycastaveis; cada um tem userData.handle
let gizmoHovered = null;

function buildGizmo() {
  gizmo = new THREE.Group();
  gizmo.visible = false;
  scene.add(gizmo);

  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3(0, 0, 1);

  for (const { axis, color } of GIZMO_AXES) {
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 });

    // seta = cilindro + cone, construida em +Y e girada pro eixo
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(GIZMO_THICKNESS, GIZMO_THICKNESS, GIZMO_ARROW_LEN, 12), mat);
    shaft.position.y = GIZMO_ARROW_LEN / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(GIZMO_THICKNESS * 2.5, 0.18, 16), mat);
    head.position.y = GIZMO_ARROW_LEN + 0.09;
    arrow.add(shaft, head);
    arrow.quaternion.setFromUnitVectors(up, axis);
    arrow.userData = { kind: "translate", axis, mat };
    shaft.userData.handle = arrow;
    head.userData.handle = arrow;
    gizmo.add(arrow);
    gizmoHandles.push(shaft, head);

    // anel = torus no plano perpendicular ao eixo
    const ring = new THREE.Mesh(new THREE.TorusGeometry(GIZMO_RING_RADIUS, GIZMO_THICKNESS, 12, 64), mat.clone());
    ring.quaternion.setFromUnitVectors(fwd, axis);
    ring.userData = { kind: "rotate", axis, mat: ring.material };
    ring.userData.handle = ring; // o anel e o proprio handle
    gizmo.add(ring);
    gizmoHandles.push(ring);
  }
}

function pickGizmoHandle(controller) {
  const hits = getIntersections(controller, gizmoHandles);
  return hits.length ? hits[0].object.userData.handle : null;
}

function gizmoStart(controller) {
  const handle = pickGizmoHandle(controller);
  if (!handle) return;
  const { kind, axis } = handle.userData;

  if (kind === "translate") {
    vrAction = {
      type: "gizmo-translate",
      controller,
      axis,
      cubeStart: cube.position.clone(),
      handStart: controller.getWorldPosition(new THREE.Vector3()),
    };
    countVrModeSwitch("translate");
  } else {
    // plano do anel: normal = eixo, passando pelo centro do cubo
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, cube.position);
    const hit0 = rayPlaneHit(controller, plane, new THREE.Vector3());
    if (!hit0) return; // raio paralelo ao plano, nao da pra medir angulo
    vrAction = {
      type: "gizmo-rotate",
      controller,
      axis,
      plane,
      startDir: hit0.sub(cube.position).normalize(),
      cubeQStart: cube.quaternion.clone(),
    };
    countVrModeSwitch("rotate");
  }
}

function updateGizmo() {
  const { controller, axis } = vrAction;
  if (vrAction.type === "gizmo-translate") {
    // so a componente do movimento da mao ao longo do eixo passa
    controller.getWorldPosition(_tmpVec).sub(vrAction.handStart);
    const along = _tmpVec.dot(axis);
    cube.position.copy(vrAction.cubeStart).addScaledVector(axis, along);
  } else {
    if (!rayPlaneHit(controller, vrAction.plane, _tmpVec)) return;
    _tmpVec.sub(cube.position).normalize();
    // angulo com sinal de startDir pra _tmpVec em torno do eixo
    _tmpVec2.crossVectors(vrAction.startDir, _tmpVec);
    const angle = Math.atan2(_tmpVec2.dot(axis), vrAction.startDir.dot(_tmpVec));
    _tmpQuat.setFromAxisAngle(axis, angle);
    cube.quaternion.copy(_tmpQuat).multiply(vrAction.cubeQStart);
  }
}

// gizmo segue o cubo e acende o handle que o controle esta apontando
function updateGizmoVisual(mapping) {
  gizmo.visible = mapping === "vr-gizmo";
  if (!gizmo.visible) return;
  gizmo.position.copy(cube.position);
  gizmo.updateMatrixWorld(true); // raycast do selectstart precisa dos handles no lugar certo

  // segurando: acende o handle que pegou; senao, o que esta sendo apontado
  let active = null;
  if (vrAction) {
    const kind = vrAction.type === "gizmo-translate" ? "translate" : "rotate";
    active = gizmo.children.find((h) => h.userData.kind === kind && h.userData.axis === vrAction.axis);
  } else if (renderer.xr.isPresenting) {
    active = pickGizmoHandle(manipulationController());
  }
  if (active === gizmoHovered) return;
  if (gizmoHovered) gizmoHovered.userData.mat.emissiveIntensity = 0.25;
  if (active) active.userData.mat.emissiveIntensity = 1.0;
  gizmoHovered = active;
}

// --- HUD dentro do VR ---------------------------------------------------------
//
// O #hud do html nao existe dentro do headset, entao desenho o mesmo texto
// (trial, dPos, dRot) num canvas, jogo num plano e prendo o plano na camera —
// fica sempre no canto de baixo do campo de visao, tipo um oculos. So aparece
// em VR; no desktop continua o HUD normal do A1.

const VR_HUD_W = 512, VR_HUD_H = 160; // pixels do canvas
let vrHud, vrHudCtx, vrHudTex, vrHudLastText = "";

function buildVrHud() {
  const canvas = document.createElement("canvas");
  canvas.width = VR_HUD_W; canvas.height = VR_HUD_H;
  vrHudCtx = canvas.getContext("2d");
  vrHudTex = new THREE.CanvasTexture(canvas);
  vrHud = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.1), // metros, mesma proporcao do canvas
    new THREE.MeshBasicMaterial({ map: vrHudTex, transparent: true, depthTest: false })
  );
  vrHud.position.set(0, -0.16, -0.6); // um pouco abaixo do centro do olhar
  vrHud.renderOrder = 999;            // desenha por cima de tudo
  vrHud.visible = false;
  camera.add(vrHud);
}

function updateVrHud() {
  vrHud.visible = renderer.xr.isPresenting;
  if (!vrHud.visible) return;
  const { positionError, orientationErrorDeg, withinTolerance } = checkTolerance();
  const key = `${trialNumber}|${positionError.toFixed(3)}|${orientationErrorDeg.toFixed(1)}|${withinTolerance}`;
  if (key === vrHudLastText) return; // so redesenha o canvas quando o texto muda
  vrHudLastText = key;

  const ctx = vrHudCtx;
  ctx.clearRect(0, 0, VR_HUD_W, VR_HUD_H);
  ctx.fillStyle = withinTolerance ? "rgba(34, 119, 68, 0.9)" : "rgba(20, 20, 20, 0.8)";
  ctx.fillRect(0, 0, VR_HUD_W, VR_HUD_H);
  ctx.fillStyle = withinTolerance ? "#9f9" : "#eee";
  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(`dPos ${positionError.toFixed(3)} m   dRot ${orientationErrorDeg.toFixed(1)} deg`, VR_HUD_W / 2, VR_HUD_H / 2 - 24);
  ctx.font = "26px system-ui, sans-serif";
  ctx.fillText(`Trial ${trialNumber + 1}${withinTolerance ? "  -  DENTRO DA TOLERANCIA" : ""}`, VR_HUD_W / 2, VR_HUD_H / 2 + 30);
  vrHudTex.needsUpdate = true;
}

function updateVr(mapping) {
  // o xr atualiza a matrix local dos controles antes deste callback, mas o
  // matrixWorld so no render — forca aqui pra nao ler a pose do frame passado
  player.updateMatrixWorld(true);
  if (vrAction) {
    if (vrAction.type === "grab") updateGrab();
    else if (vrAction.type === "translate" || vrAction.type === "rotate") updateTrackball();
    else updateGizmo();
  }
  updateGizmoVisual(mapping); // depois de mover o cubo, senao o gizmo fica um frame atras
}
// ===== END VR =====

const rows = [];
const CSV_HEADER = [
  "participant_id",
  "mapping",
  "trial_number",
  "presentation_order",
  "completion_time_s",
  "final_position_error",
  "final_orientation_error_deg",
  "mode_switches",
  "path_length",
  "vr_experience",
];

function currentMapping() {
  return mappingSelect.value;
}

function startTrial() {
  trialStartTime = performance.now();
  pathLength = 0;
  lastCubePosition.copy(cube.position);
  modeSwitches = 0;
  vrLastKind = null;
  generateTargetPose();
  trialCountEl.textContent = `Trial ${trialNumber + 1}`;
}

function confirmTrial() {
  const { positionError, orientationErrorDeg } = checkTolerance();
  const completionTimeS = (performance.now() - trialStartTime) / 1000;
  const mapping = currentMapping();

  trialNumber += 1;
  presentationOrderByMapping[mapping] = (presentationOrderByMapping[mapping] || 0) + 1;

  rows.push({
    participant_id: participantIdInput.value.trim() || "UNKNOWN",
    mapping,
    trial_number: trialNumber,
    presentation_order: presentationOrderByMapping[mapping],
    completion_time_s: completionTimeS.toFixed(3),
    final_position_error: positionError.toFixed(4),
    final_orientation_error_deg: orientationErrorDeg.toFixed(2),
    mode_switches: modeSwitches,
    path_length: pathLength.toFixed(4),
    vr_experience: vrExperienceSelect.value || "NA",
  });

  startTrial();
}

function switchMode() {
  modeSwitches += 1;
  isRotating = !isRotating; // Toggle the rotation mode
  // show the current mode on the help text so the participant doesnt get lost
  const helpEl = document.getElementById("help");
  if (helpEl) {
    helpEl.textContent = isRotating
      ? "MODO: ROTACAO — segure o cubo e arraste o mouse (yaw/pitch), scroll = roll. Space/Tab volta para translacao."
      : "MODO: TRANSLACAO — segure o cubo e arraste (X/Y), scroll = Z. Space/Tab vai para rotacao.";
  }
  console.log(`Mode switched. Now in ${isRotating ? "rotation" : "translation"} mode.`);
}

confirmBtn.addEventListener("click", confirmTrial);
window.addEventListener("keydown", handleKeydown);

/**
 * handleKeydown(e)
 *
 * Keyboard shortcut for Confirm: Enter does the same thing as clicking
 * #confirmBtn. Registered as the "keydown" listener above.
 */


// ---------------------------------------------------------------------------
// CSV download — provided
// ---------------------------------------------------------------------------

function buildCsv() {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      CSV_HEADER.map(function (key) {
        return row[key];
      }).join(",")
    );
  }
  return lines.join("\n");
}

downloadBtn.addEventListener("click", handleDownloadClick);

/**
 * handleDownloadClick()
 *
 * Builds the CSV from `rows` (via buildCsv()), then triggers a browser
 * download through a temporary Blob URL and an off-DOM `<a>` click.
 * Registered as the "click" listener on #downloadBtn above.
 */
function handleDownloadClick() {
  const csv = buildCsv();
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const pid = participantIdInput.value.trim() || "UNKNOWN";
  a.href = url;
  a.download = `a2_${pid}_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Status indicator — provided
// ---------------------------------------------------------------------------

function updateStatus() {
  const { positionError, orientationErrorDeg, withinTolerance } = checkTolerance();
  statusEl.textContent = `dPos ${positionError.toFixed(3)} | dRot ${orientationErrorDeg.toFixed(1)}deg`;
  statusEl.classList.toggle("in-tolerance", withinTolerance);
  // dentro do headset o HUD nao aparece, entao o proprio alvo acende de verde
  // quando esta na tolerancia — mesma dica do status pill, so muda o lugar.
  // fora do VR o alvo fica igual ao A1 pra nao mudar a condicao desktop
  const inVr = renderer.xr.isPresenting;
  target.material.emissive.setHex(inVr && withinTolerance ? 0x2ecc71 : 0x000000);
  updateVrHud();
}

// ---------------------------------------------------------------------------
// Control mapping — STUDENT TODO
//
// updateControlMapping(delta) is called once per animation frame. This is
// where mouse/keyboard input should translate into changes to cube.position
// and cube.quaternion. The baseline mapping (mapping "1") is the translate-rotation
// toggled by TAB/Spacebar.
// Mapping "2" is your own design.
//
// Whatever you build:
//   - Read currentMapping() to branch between mapping 1 and mapping 2.
//   - Update cube.position / cube.quaternion directly.
//   - Increment modeSwitches whenever the user changes input mode.
//   - Accumulate pathLength (see the render loop below, which already does
//     this generically by measuring cube.position deltas frame-to-frame —
//     you likely don't need to touch that part).
//
// ===== STUDENT TODO =====

// Nothing here moves the cube yet, so it will sit still on load. Wire up
// your own mouse/keyboard listeners (mousemove, keydown/keyup, etc.) above
// this function as needed, and drive cube.position / cube.quaternion from
// updateControlMapping() below.

function updateControlMapping(delta) {
  const mapping = currentMapping();

  if (mapping.startsWith("vr")) {
    // as tres condicoes VR ficam la em cima no bloco VR
    updateVr(mapping);
    return;
  }
  gizmo.visible = false; // se trocou de vr-gizmo pra desktop no select

  if (mapping === "desktop-1") {
    // Mapping 1 — mode-switched: Space/Tab alterna TRANSLATE/ROTATE
    // Scroll: Z no modo translação, roll no modo rotação
    if (wheelDY !== 0) {
      if (isRotating) {
        cube.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), wheelDY * 0.0005);
      } else {
        cube.position.z += wheelDY * 0.0005;
      }
      wheelDY = 0;
    }
    // só mexe se clicou no cubo e está segurando o botão esquerdo
    if (!cubeSelected) { moveDX = 0; moveDY = 0; return; }
    if (isLeftDown && !isRotating) {
      // translation mode: drag XY 1:1
      raycaster.setFromCamera(mouseNDC, camera);
      if (raycaster.ray.intersectPlane(dragPlane, dragIntersect)) {
        cube.position.x = dragIntersect.x - dragOffset.x;
        cube.position.y = dragIntersect.y - dragOffset.y;
      }
    } else if (isLeftDown && isRotating) {
      // rotation mode: mouse X = yaw, mouse Y = pitch (world axes)
      if (moveDX !== 0 || moveDY !== 0) {
        cube.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), moveDX * ROTATE_SPEED);
        cube.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), moveDY * ROTATE_SPEED);
        moveDX = 0; moveDY = 0;
      }
    } else {
      moveDX = 0; moveDY = 0;
    }
  } else {
    // Mapping 2 — esquerdo = translada, direito = rotaciona, scroll = Z, setas = roll
    // arrows = roll, works from anywhere, mouse doesnt need to be over the cube
    if (arrowDir !== 0) {
      cube.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), arrowDir * 4*ROTATE_SPEED * 40 * delta);
    }
    // scroll sempre anda em Z, e se o direito tiver segurado gira junto
    if (wheelDY !== 0) {
      cube.position.z += wheelDY * 0.0005;
      if (isRightDown) cube.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), wheelDY * 0.0005);
      wheelDY = 0;
    }
    if (!cubeSelected) { moveDX = 0; moveDY = 0; return; }
    // left and right are independent now, can hold both at the same time
    if (isLeftDown) {
      raycaster.setFromCamera(mouseNDC, camera);
      if (raycaster.ray.intersectPlane(dragPlane, dragIntersect)) {
        cube.position.x = dragIntersect.x - dragOffset.x;
        cube.position.y = dragIntersect.y - dragOffset.y;
      }
    }
    if (isRightDown) {
      if (moveDX !== 0 || moveDY !== 0) {
        cube.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), moveDX * ROTATE_SPEED);
        cube.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), moveDY * ROTATE_SPEED);
        moveDX = 0; moveDY = 0;
      }
    }
    if (!isLeftDown && !isRightDown) { moveDX = 0; moveDY = 0; }
  }
}

// ===== END STUDENT TODO =====

// ---------------------------------------------------------------------------
// Render loop — provided
//
// Agora roda via renderer.setAnimationLoop (ver main()) em vez de
// requestAnimationFrame — e o unico jeito do WebXR chamar o loop na taxa
// do headset. No desktop nao muda nada.
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function animate() {
  const delta = clock.getDelta();

  updateControlMapping(delta);

  // Generic path-length accumulation — measures how far the cube has
  // physically travelled this trial, regardless of mapping.
  pathLength += cube.position.distanceTo(lastCubePosition);
  lastCubePosition.copy(cube.position);

  updateStatus();
  renderer.render(scene, camera);
}

main();
