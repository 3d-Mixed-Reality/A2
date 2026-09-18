// MAC0623 — A1 Desktop Docking Testbed — STARTER
//
// Provided: scene setup, target-pose generation, the tolerance check, the
// trial state machine, and the CSV logger/downloader.
//
// You implement: the control mapping(s) that move/rotate the cube in
// response to input. Everything you need to touch is inside blocks marked
//   // ===== STUDENT TODO ===== ... // ===== END STUDENT TODO =====
// Do not need to touch anything outside those blocks to get a working
// baseline mapping — but you may, if your design requires it (e.g. extra
// HUD state for a second input mode). If you do, note it in your README.

import * as THREE from "three";

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
 *   3. Start the trial state machine (`startTrial()`), which generates the
 *      first target pose.
 *   4. Start the render loop (`animate()`).
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
  camera.position.set(0, 1.4, 4);
  camera.lookAt(0, 0.5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  window.addEventListener("resize", handleWindowResize);

  startTrial();
  animate();
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
let presentationOrderByMapping = { 1: 0, 2: 0 };
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
    // only mapping 1 has modes, mapping 2 must stay with mode_switches = 0
    if (currentMapping() === "1") switchMode();
  }
  // arrows for roll
  if (e.key === "ArrowUp") arrowDir = 1;
  if (e.key === "ArrowDown") arrowDir = -1;
}
window.addEventListener('keyup', (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") arrowDir = 0;
});
// ===== END STUDENT TODO =====

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
];

function currentMapping() {
  return mappingSelect.value;
}

function startTrial() {
  trialStartTime = performance.now();
  pathLength = 0;
  lastCubePosition.copy(cube.position);
  modeSwitches = 0;
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
  a.download = `a1_${pid}_${Date.now()}.csv`;
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

  if (mapping === "1") {
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
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
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
