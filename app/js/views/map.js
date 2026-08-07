// The grid as geography.
//
// Everything drawn here is measured, and the map is careful about which
// measurement each thing is, because the three are routinely confused:
//
//   Demand is consumption — AEMO's TOTALDEMAND per region, five-minutely. It
//   sets the glow of each state's floor. It is regional, not local: the finest
//   granularity any public Australian source publishes is a whole state, so a
//   street-level heat map cannot be drawn honestly and is not attempted.
//
//   Generation is what each station produced. Stations sit at their real
//   coordinates, coloured by fuel, and rise and brighten with output as the
//   replay runs.
//
//   Flow is power crossing an interconnector, with a sign. Arcs travel in the
//   direction the electricity actually went, and their speed and brightness
//   follow the magnitude.
//
// Western Australia carries stations and no arcs, which is not a gap: the SWIS
// has no interconnector to the eastern grid at all. The map says so rather than
// leaving a reader to assume the data is missing.

import * as THREE from '/vendor/three/build/three.module.js';
import { fueltechColour, FUELTECH_CODE } from '../charts/base.js';

// Australia in degrees, and the plane it is drawn on. Longitude east and
// latitude north map to x and z; y is reserved for quantity, so height on this
// map always means "how much", never elevation.
const LON0 = 113;
const LON1 = 154;
const LAT0 = -44;
const LAT1 = -10;
const SPAN = 40;

const project = (lon, lat) => [
  ((lon - LON0) / (LON1 - LON0) - 0.5) * SPAN,
  -((lat - LAT0) / (LAT1 - LAT0) - 0.5) * SPAN * ((LAT1 - LAT0) / (LON1 - LON0)),
];

// Which NEM region each state's floor belongs to. The ACT sits inside NSW1 and
// has no separate demand figure; the Northern Territory is on neither grid.
const STATE_REGION = {
  'New South Wales': 'NSW1',
  'Australian Capital Territory': 'NSW1',
  Victoria: 'VIC1',
  Queensland: 'QLD1',
  'South Australia': 'SA1',
  Tasmania: 'TAS1',
  'Western Australia': 'SWIS',
  'Northern Territory': null,
};

// Interconnectors as they are named in the dispatch feed, and the regions each
// joins. A positive MWFLOW runs from the first to the second.
const LINKS = {
  'N-Q-MNSP1': ['NSW1', 'QLD1'],
  'NSW1-QLD1': ['NSW1', 'QLD1'],
  'VIC1-NSW1': ['VIC1', 'NSW1'],
  'V-SA': ['VIC1', 'SA1'],
  'V-S-MNSP1': ['VIC1', 'SA1'],
  'T-V-MNSP1': ['TAS1', 'VIC1'],
};

const REGION_AT = {
  NSW1: [147.0, -32.5],
  QLD1: [146.5, -22.5],
  VIC1: [144.5, -37.0],
  SA1: [135.5, -31.0],
  TAS1: [146.7, -42.0],
  SWIS: [117.5, -31.5],
};

const hexToColor = (hex) => new THREE.Color(hex || '#8ca0ab');

export function mount(root, ctx) {
  const host = root.querySelector('#map-canvas');
  const legend = root.querySelector('#map-legend');
  if (!host) return { update() {}, destroy() {} };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Light fog only. At the distance needed to frame the continent, anything
  // denser than this renders the far half of the map as background.
  scene.fog = new THREE.FogExp2(0x0d1317, 0.0045);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);
  scene.add(new THREE.AmbientLight(0xbfd0da, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(-12, 26, 10);
  scene.add(key);

  // A slow orbit the reader can take over. Auto-rotation stops on first drag,
  // because a map that keeps moving under a pointer is hostile.
  // Far enough that the whole continent frames: the map spans 40 units across
  // and the vertical field of view is 38 degrees, so anything closer crops
  // Western Australia off one edge.
  // North up, east right, and still. A map that rotates on its own is
  // disorienting for the one job this view has — telling you where things are —
  // so the reader turns it or it stays put.
  const view = { angle: 0, tilt: 1.02, distance: 58 };
  // The camera eases toward whatever the pointer asked for. Applying drag
  // deltas straight to the transform is what made turning the map feel like
  // dragging a heavy object across a rough floor.
  const target = { ...view };
  const applyCamera = () => {
    const r = view.distance;
    camera.position.set(
      Math.sin(view.angle) * r * Math.cos(view.tilt),
      Math.sin(view.tilt) * r,
      Math.cos(view.angle) * r * Math.cos(view.tilt),
    );
    camera.lookAt(0, 0, 0);
  };

  const stateGroup = new THREE.Group();
  const floorGroup = new THREE.Group();
  const stationGroup = new THREE.Group();
  const arcGroup = new THREE.Group();
  scene.add(stateGroup, floorGroup, stationGroup, arcGroup);

  const floors = new Map();      // region -> mesh
  const stationMeshes = [];
  const arcs = [];
  let stations = [];
  let ready = false;

  // ---- geography --------------------------------------------------------
  fetch(`${globalThis.GRIDSENSE_API_BASE ?? ''}/data/au-states.json`)
    .then((r) => r.json())
    .then(({ states }) => {
      for (const state of states) {
        const region = STATE_REGION[state.name];
        for (const ring of state.rings) {
          const pts = ring.map(([lon, lat]) => {
            const [x, z] = project(lon, lat);
            return new THREE.Vector3(x, 0, z);
          });
          const outline = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({ color: 0x35505e, transparent: true, opacity: 0.9 }),
          );
          stateGroup.add(outline);
        }

        // The demand floor: one flat shape per region, lit from beneath. Its
        // brightness is consumption, so a state literally glows as it draws.
        if (!region || floors.has(region)) continue;
        const biggest = state.rings[0];
        if (!biggest) continue;
        const shape = new THREE.Shape(biggest.map(([lon, lat]) => {
          const [x, z] = project(lon, lat);
          return new THREE.Vector2(x, z);
        }));
        const mesh = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({
            color: 0x2b6f8f, transparent: true, opacity: 0.06,
            side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        mesh.rotation.x = Math.PI / 2;
        mesh.position.y = -0.02;
        floorGroup.add(mesh);
        floors.set(region, mesh);
      }
      ready = true;
    })
    .catch(() => {
      host.innerHTML = '<p class="state-msg"><strong>Map geometry unavailable</strong>' +
        'app/data/au-states.json did not load, so the coastline cannot be drawn.</p>';
    });

  // ---- stations ---------------------------------------------------------
  function buildStations(rows) {
    for (const m of stationMeshes) {
      m.geometry.dispose();
      m.material.dispose();
      stationGroup.remove(m);
    }
    stationMeshes.length = 0;

    for (const s of rows) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const [x, z] = project(s.lon, s.lat);
      // Radius from nameplate so a 2.8 GW coal station reads as bigger than a
      // 20 MW farm, on a cube root so the largest does not swamp the map.
      const r = 0.09 + Math.cbrt(Math.max(s.capacity_mw, 1)) * 0.021;
      const colour = hexToColor(fueltechColour(s.fueltech));
      // Additive, so overlapping columns in the Latrobe or Hunter valleys read
      // as one brighter cluster instead of a muddy pile of translucent tubes —
      // which is exactly what stacked alpha was doing.
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 1.25, 1, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: colour, transparent: true, opacity: 0.62,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      mesh.position.set(x, 0, z);
      mesh.userData = { id: s.station_id, capacity: s.capacity_mw };
      stationGroup.add(mesh);

      // A disc on the ground under each column: it anchors the station to a
      // place even when its output is zero and the column has nothing to draw.
      const foot = new THREE.Mesh(
        new THREE.CircleGeometry(r * 2.6, 12),
        new THREE.MeshBasicMaterial({
          color: colour, transparent: true, opacity: 0.16,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      foot.rotation.x = -Math.PI / 2;
      foot.position.set(x, 0.01, z);
      stationGroup.add(foot);

      mesh.userData.foot = foot;
      stationMeshes.push(mesh);
    }
  }

  // ---- interconnector arcs ----------------------------------------------
  function buildArcs() {
    for (const a of arcs) {
      a.line.geometry.dispose();
      a.line.material.dispose();
      arcGroup.remove(a.line);
    }
    arcs.length = 0;

    for (const [id, [from, to]] of Object.entries(LINKS)) {
      const a = REGION_AT[from];
      const b = REGION_AT[to];
      if (!a || !b) continue;
      const [ax, az] = project(a[0], a[1]);
      const [bx, bz] = project(b[0], b[1]);
      const lift = Math.hypot(bx - ax, bz - az) * 0.42;
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(ax, 0.35, az),
        new THREE.Vector3((ax + bx) / 2, lift, (az + bz) / 2),
        new THREE.Vector3(bx, 0.35, bz),
      );
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
        new THREE.LineBasicMaterial({ color: 0xa98bff, transparent: true, opacity: 0.18 }),
      );
      arcGroup.add(line);
      arcs.push({ id, curve, line, from, to, mw: 0 });
    }
  }
  buildArcs();

  // Three pulses per arc, evenly spaced. One dot crawling a long curve reads as
  // a stray highlight; a train of them reads as flow, and their spacing carries
  // the rate without needing a number.
  const PULSES_PER_ARC = 3;
  const pulseGeom = new THREE.SphereGeometry(0.17, 10, 10);
  const pulses = [];
  for (const a of arcs) {
    for (let k = 0; k < PULSES_PER_ARC; k++) {
      const m = new THREE.Mesh(pulseGeom, new THREE.MeshBasicMaterial({
        color: 0xe0d4ff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      arcGroup.add(m);
      pulses.push({ arc: a, mesh: m, offset: k / PULSES_PER_ARC });
    }
  }
  let flowPhase = 0;

  // ---- interaction -------------------------------------------------------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
  const onMove = (e) => {
    if (!dragging) return;
    target.angle -= (e.clientX - lastX) * 0.006;
    target.tilt = Math.max(0.3, Math.min(1.5, target.tilt + (e.clientY - lastY) * 0.005));
    lastX = e.clientX; lastY = e.clientY;
  };
  const onUp = () => { dragging = false; };
  const onWheel = (e) => {
    e.preventDefault();
    target.distance = Math.max(34, Math.min(140, target.distance + e.deltaY * 0.05));
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  // ---- the loop ----------------------------------------------------------
  const state = { demand: {}, flow: {}, output: null, peakDemand: 1 };
  let raf = 0;
  let last = performance.now();

  function resize() {
    const rect = host.getBoundingClientRect();
    const w = Math.max(rect.width, 240);
    const h = Math.max(rect.height, 240);
    // updateStyle must stay on: with it off the canvas keeps whatever CSS size
    // it had while its backing store grows by the pixel ratio, so the scene
    // renders at double size and the viewport shows one corner of the map.
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const ease = 1 - Math.exp(-dt * 9);
    view.angle += (target.angle - view.angle) * ease;
    view.tilt += (target.tilt - view.tilt) * ease;
    view.distance += (target.distance - view.distance) * ease;
    applyCamera();

    // Demand sets each region's floor glow.
    for (const [region, mesh] of floors) {
      const mw = state.demand[region];
      const share = Number.isFinite(mw) ? Math.min(mw / state.peakDemand, 1.2) : 0;
      mesh.material.opacity = 0.05 + share * 0.42;
      mesh.material.color.setHSL(0.55 - share * 0.11, 0.65, 0.22 + share * 0.28);
    }

    // Generation sets each station's height and brightness.
    for (const mesh of stationMeshes) {
      const mw = state.output?.get?.(mesh.userData.id);
      const frac = Number.isFinite(mw) && mesh.userData.capacity > 0
        ? Math.max(0, Math.min(mw / mesh.userData.capacity, 1))
        : 0;
      const height = 0.15 + frac * 5.4;
      mesh.scale.y = height;
      mesh.position.y = height / 2;
      mesh.material.opacity = 0.2 + frac * 0.6;
      if (mesh.userData.foot) mesh.userData.foot.material.opacity = 0.1 + frac * 0.35;
    }

    // Flow drives arc brightness and the pulse that travels along it.
    flowPhase = (flowPhase + dt * 0.22) % 1;
    for (const p of pulses) {
      const mw = state.flow[p.arc.id] ?? 0;
      const mag = Math.min(Math.abs(mw) / 900, 1);
      p.arc.line.material.opacity = 0.14 + mag * 0.6;
      if (mag < 0.02) { p.mesh.material.opacity = 0; continue; }
      // Speed scales with flow, so a heavily loaded link visibly runs faster.
      const along = (flowPhase * (0.6 + mag * 2.2) + p.offset) % 1;
      // Negative flow runs the other way along the same curve.
      p.mesh.position.copy(p.arc.curve.getPoint(mw >= 0 ? along : 1 - along));
      p.mesh.scale.setScalar(0.55 + mag * 0.9);
      // Fade at both ends so pulses arrive and depart rather than blinking out.
      p.mesh.material.opacity = (0.2 + mag * 0.7) * Math.sin(along * Math.PI);
    }

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // Fuel keys actually present on the map, so the legend never advertises a
  // colour the reader cannot find.
  function renderFuelKey(rows) {
    const host = root.querySelector('#map-fuels');
    if (!host) return;
    const present = [...new Set(rows.map((r) => r.fueltech))].filter(Boolean).sort();
    host.innerHTML = present.map((ft) =>
      `<span class="ft"><span class="ft-swatch" style="background:${fueltechColour(ft)}"></span>` +
      `<span class="ft-code">${FUELTECH_CODE[ft] ?? ft}</span></span>`).join('');
  }

  function renderLegend() {
    if (!legend) return;
    const rows = Object.entries(state.demand)
      .sort((a, b) => b[1] - a[1])
      .map(([r, mw]) => `<tr><td>${r === 'SWIS' ? 'SWIS *' : r}</td><td>${(mw / 1000).toFixed(2)}</td></tr>`)
      .join('');
    const links = arcs
      .map((a) => {
        const mw = state.flow[a.id] ?? 0;
        const dir = mw >= 0 ? `${a.from} → ${a.to}` : `${a.to} → ${a.from}`;
        return `<tr><td>${dir}</td><td>${Math.abs(mw).toFixed(0)}</td></tr>`;
      })
      .join('');
    legend.innerHTML =
      `<table><thead><tr><th>Region</th><th>Demand GW</th></tr></thead><tbody>${rows}` +
      `</tbody></table><table><thead><tr><th>Flowing</th><th>MW</th></tr></thead><tbody>${links}</tbody></table>` +
      '<p class="map-foot">* Western Australia, a separate grid — never added to the NEM total.</p>';
  }

  return {
    update(appState) {
      if (!ready) return;
      const rows = appState.stationRows ?? [];
      if (rows.length && stationMeshes.length !== rows.filter((s) => Number.isFinite(s.lat)).length) {
        buildStations(rows);
        renderFuelKey(rows);
      }
      state.output = appState.stationOutput ?? state.output;

      const at = appState.nowSec;
      const cell = Number.isFinite(at) ? ctx.flowsAt?.(at * 1000) : null;
      if (cell) {
        state.demand = cell.demand;
        state.flow = cell.flow;
        const peak = Math.max(...Object.values(cell.demand));
        if (Number.isFinite(peak)) state.peakDemand = Math.max(state.peakDemand * 0.999, peak);
        renderLegend();
      }
    },
    resize,
    destroy() {
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
