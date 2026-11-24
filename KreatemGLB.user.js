// ==UserScript==
// @name         KreatemGLB
// @namespace    https://vectaria.io/
// @version      1.7
// @description  Universal 3D asset ripper and GLB exporter for Vectaria.io: hand items, raycast crosshair capture, and world entity inspector.
// @author       PIllagerJ88
// @match        https://vectaria.io/*
// @match        https://*.vectaria.io/*
// @icon         https://vectaria.io/favicon.ico
// @updateURL    https://raw.githubusercontent.com/CMG-works/KreatemGLB/main/KreatemGLB.user.js
// @downloadURL  https://raw.githubusercontent.com/CMG-works/KreatemGLB/main/KreatemGLB.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const SCRIPT_NAME = 'KreatemGLB';
  const SCRIPT_VERSION = '1.7';
  const STORAGE_KEY = 'kreatemglb_settings_v1';

  if (window[`__${SCRIPT_NAME.toUpperCase()}_INITIALIZED__`]) return;
  window[`__${SCRIPT_NAME.toUpperCase()}_INITIALIZED__`] = true;

  console.log(`[${SCRIPT_NAME}] Userscript v${SCRIPT_VERSION} loaded.`);

  //SETTINGS AND PERSISTENCE
  const defaultSettings = {
    minimized: false,
    posX: null,
    posY: null,
    hotkeyRaycast: 'KeyG' // Alt + G for instant download of the block under the crosshair
  };

  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? Object.assign({}, defaultSettings, JSON.parse(saved)) : Object.assign({}, defaultSettings);
    } catch (e) {
      return Object.assign({}, defaultSettings);
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {}
  }

  const settings = loadSettings();

  //UNWRAPPING VUE 3 / PINIA PROXIES
  function unwrapProxy(obj) {
    if (!obj) return obj;
    let cur = obj;
    let depth = 0;
    while (cur && cur.__v_raw && depth < 10) {
      cur = cur.__v_raw;
      depth++;
    }
    return cur;
  }

  //DYNAMIC LOADING OF THREE.JS, SKELETONUTILS AND GLTF EXPORTER
  let THREE = null;
  let GLTFExporter = null;
  let SkeletonUtils = null;
  let isModulesLoading = false;

  async function loadModules() {
    if (THREE && GLTFExporter && SkeletonUtils) return true;
    if (isModulesLoading) {
      while (isModulesLoading) await new Promise(r => setTimeout(r, 100));
      return !!(THREE && GLTFExporter && SkeletonUtils);
    }
    isModulesLoading = true;
    try {
      const [threeModule, exporterModule, skeletonModule] = await Promise.all([
        import('https://esm.sh/three@0.156.0'),
        import('https://esm.sh/three@0.156.0/examples/jsm/exporters/GLTFExporter.js'),
        import('https://esm.sh/three@0.156.0/examples/jsm/utils/SkeletonUtils.js')
      ]);
      THREE = threeModule;
      GLTFExporter = exporterModule.GLTFExporter;
      SkeletonUtils = skeletonModule;
      isModulesLoading = false;
      return true;
    } catch (err) {
      console.error(`[${SCRIPT_NAME}] Error loading 3D modules:`, err);
      isModulesLoading = false;
      return false;
    }
  }

  //GLTF 2.0 SANITIZER (BLENDER 5.2 & BLOCKBENCH COMPATIBLE)
  function sanitizeGLB(arrayBuffer) {
    const dataView = new DataView(arrayBuffer);
    const magic = dataView.getUint32(0, true);
    if (magic !== 0x46546c67) return arrayBuffer; // not 'glTF'

    const totalLength = dataView.getUint32(8, true);
    const jsonChunkLen = dataView.getUint32(12, true);
    const jsonChunkType = dataView.getUint32(16, true);
    if (jsonChunkType !== 0x4e4f534a) return arrayBuffer;

    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();
    const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonChunkLen);
    const jsonText = decoder.decode(jsonBytes);
    const gltf = JSON.parse(jsonText);
    let modified = false;

    //remove invalid COLOR_0 attributes
    if (gltf.meshes) {
      for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives || []) {
          if (prim.attributes && prim.attributes.COLOR_0 !== undefined) {
            const accId = prim.attributes.COLOR_0;
            const acc = gltf.accessors?.[accId];
            if (acc && acc.type !== 'VEC3' && acc.type !== 'VEC4') {
              delete prim.attributes.COLOR_0;
              modified = true;
            }
          }
        }
      }
    }

    // fix accessor bounds
    if (gltf.accessors) {
      for (const acc of gltf.accessors) {
        ['max', 'min'].forEach(key => {
          if (acc[key]) {
            if (!Array.isArray(acc[key]) || acc[key].some(v => typeof v !== 'number' || !Number.isFinite(v))) {
              delete acc[key];
              modified = true;
            }
          }
        });
      }
    }

    // adjust materials for correct rendering
    if (gltf.materials) {
      for (const mat of gltf.materials) {
        if (mat.pbrMetallicRoughness?.baseColorTexture) {
          if (mat.alphaMode !== 'MASK' || mat.alphaCutoff !== 0.5 || !mat.doubleSided) {
            mat.alphaMode = 'MASK';
            mat.alphaCutoff = 0.5;
            mat.doubleSided = true;
            modified = true;
          }
        }
      }
    }

    //detach meshes from container nodes
    if (gltf.nodes) {
      const originalNodeCount = gltf.nodes.length;
      for (let i = 0; i < originalNodeCount; i++) {
        const node = gltf.nodes[i];
        if (node.mesh !== undefined && node.children && node.children.length > 0) {
          const meshIndex = node.mesh;
          delete node.mesh;
          const childMeshNode = {
            name: (node.name || 'node') + '_Mesh',
            mesh: meshIndex
          };
          const newIndex = gltf.nodes.length;
          gltf.nodes.push(childMeshNode);
          node.children.unshift(newIndex);
          modified = true;
        }
      }
    }

    if (!modified) return arrayBuffer;

    let newJsonText = JSON.stringify(gltf);
    const padLength = (4 - (encoder.encode(newJsonText).length % 4)) % 4;
    newJsonText += ' '.repeat(padLength);
    const newJsonBytes = encoder.encode(newJsonText);

    const binChunkOffset = 20 + jsonChunkLen;
    const hasBin = binChunkOffset < arrayBuffer.byteLength;
    const binLength = hasBin ? dataView.getUint32(binChunkOffset, true) : 0;
    const totalLengthNew = 12 + (8 + newJsonBytes.length) + (hasBin ? (8 + binLength) : 0);

    const newBuffer = new ArrayBuffer(totalLengthNew);
    const newView = new DataView(newBuffer);
    newView.setUint32(0, dataView.getUint32(0, true), true);
    newView.setUint32(4, dataView.getUint32(4, true), true);
    newView.setUint32(8, totalLengthNew, true);

    newView.setUint32(12, newJsonBytes.length, true);
    newView.setUint32(16, jsonChunkType, true);
    new Uint8Array(newBuffer, 20, newJsonBytes.length).set(newJsonBytes);

    if (hasBin) {
      const newBinOffset = 20 + newJsonBytes.length;
      newView.setUint32(newBinOffset, binLength, true);
      newView.setUint32(newBinOffset + 4, dataView.getUint32(binChunkOffset + 4, true), true);
      new Uint8Array(newBuffer, newBinOffset + 8, binLength).set(new Uint8Array(arrayBuffer, binChunkOffset + 8, binLength));
    }

    return newBuffer;
  }

  //OFFICIAL ASSET RESOLUTION ($assetsUrls)
  function findMobAssetUrl(name) {
    const assets = window.$assetsUrls;
    if (!assets || !name) return null;

    const trimmed = name.trim();
    const clean = trimmed.replace(/[^a-zA-Z0-9_\- ]/g, '').trim();

    const candidates = [
      `mobs/${trimmed}/model.glb`,
      `mobs/${trimmed}/model.gltf`,
      `mobs/${clean}/model.glb`,
      `mobs/${clean}/model.gltf`,
      `mobs/${clean.replace(/ /g, '_')}/model.glb`,
      `mobs/${clean.replace(/ /g, '_')}/model.gltf`,
      `mobs/${clean.replace(/ /g, '')}/model.glb`,
      `mobs/${clean.replace(/ /g, '')}/model.gltf`
    ];

    for (const c of candidates) {
      if (assets[c]) return assets[c];
    }

    // flexible, case-insensitive search
    const lowerClean = clean.toLowerCase();
    const noSpace = lowerClean.replace(/[ _]/g, '');
    for (const [key, url] of Object.entries(assets)) {
      if (key.startsWith('mobs/') && (key.endsWith('/model.glb') || key.endsWith('/model.gltf'))) {
        const mobPart = key.split('/')[1]?.toLowerCase();
        if (mobPart) {
          const mobNoSpace = mobPart.replace(/[ _]/g, '');
          if (mobPart === lowerClean || mobNoSpace === noSpace || lowerClean.includes(mobPart) || mobPart.includes(lowerClean)) {
            return url;
          }
        }
      }
    }

    return null;
  }

  //UNIVERSAL GLB EXPORT ENGINE
  async function exportObjectToGLB(rawObject, baseName, animations = []) {
    await loadModules();

    const raw = unwrapProxy(rawObject);
    if (!raw) throw new Error("Invalid 3D object for export.");

    // safe cloning
    let hasSkin = false;
    raw.traverse(c => {
      const unwrapped = unwrapProxy(c);
      if (unwrapped && (unwrapped.isSkinnedMesh || unwrapped.isBone)) hasSkin = true;
    });

    let clone;
    try {
      const cloneFn = SkeletonUtils?.clone || SkeletonUtils?.SkeletonUtils?.clone || SkeletonUtils?.default?.clone;
      if (cloneFn && hasSkin) {
        clone = cloneFn(raw);
      } else {
        clone = raw.clone(true);
      }
    } catch (e) {
      clone = raw.clone(true);
    }

    //center at the origin
    clone.position.set(0, 0, 0);
    clone.rotation.set(0, 0, 0);
    clone.scale.set(1, 1, 1);

    if (THREE) {
      const box = new THREE.Box3().setFromObject(clone);
      if (!box.isEmpty()) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        clone.position.sub(center);
        clone.position.y += (box.max.y - box.min.y) / 2;
      }
    }
    clone.updateMatrixWorld(true);

    //convert any SkinnedMesh into a standard THREE.Mesh
    if (THREE) {
      const toReplace = [];
      clone.traverse(child => {
        const unwrapped = unwrapProxy(child);
        if (unwrapped && unwrapped.isSkinnedMesh) {
          toReplace.push(child);
        }
      });

      for (const sm of toReplace) {
        const parent = sm.parent;
        if (!parent) continue;

        const geom = sm.geometry ? sm.geometry.clone() : new THREE.BufferGeometry();
        if (geom.deleteAttribute) {
          geom.deleteAttribute('skinIndex');
          geom.deleteAttribute('skinWeight');
        }
        if (!geom.groups) geom.groups = [];

        const plainMesh = new THREE.Mesh(geom, sm.material);
        plainMesh.name = sm.name || 'MeshPart';
        plainMesh.position.copy(sm.position);
        plainMesh.quaternion.copy(sm.quaternion);
        plainMesh.scale.copy(sm.scale);
        plainMesh.matrix.copy(sm.matrix);
        plainMesh.matrixWorld.copy(sm.matrixWorld);
        plainMesh.matrixAutoUpdate = sm.matrixAutoUpdate;
        plainMesh.visible = sm.visible;

        const childrenToMove = [];
        sm.children.forEach(ch => {
          if (!ch.isBone) childrenToMove.push(ch);
        });
        childrenToMove.forEach(ch => plainMesh.add(ch));

        parent.add(plainMesh);
        parent.remove(sm);
      }

      //disable bone flags
      clone.traverse(node => {
        if (node.isBone) {
          node.isBone = false;
          node.type = 'Group';
        }
      });
    }

    // convert ShaderMaterial to MeshStandardMaterial while preserving maps and textures
    clone.traverse(child => {
      const c = unwrapProxy(child);
      if (c && c.isMesh) {
        // ensure groups and clean scalar colors in the geometry
        if (c.geometry) {
          if (!c.geometry.groups) c.geometry.groups = [];
          const col = c.geometry.getAttribute('color');
          if (col && col.itemSize < 3) c.geometry.deleteAttribute('color');
        }

        if (c.material) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          const converted = mats.map(mRaw => {
            const m = unwrapProxy(mRaw);
            if (!m) return new THREE.MeshStandardMaterial({ color: 0xffffff });

            const map = m.uniforms?.u_tex?.value || m.uniforms?.map?.value || m.map || null;
            const diffuse = m.uniforms?.u_color?.value || m.uniforms?.diffuse?.value || m.color || 0xffffff;

            if (m.type === 'ShaderMaterial' || m.isShaderMaterial || !m.isMeshStandardMaterial) {
              return new THREE.MeshStandardMaterial({
                map: map,
                color: diffuse,
                roughness: 0.8,
                metalness: 0.1,
                transparent: false,
                alphaTest: 0.5,
                opacity: 1,
                side: THREE.DoubleSide
              });
            } else {
              m.transparent = false;
              m.alphaTest = 0.5;
              m.side = THREE.DoubleSide;
              m.needsUpdate = true;
              return m;
            }
          });
          child.material = Array.isArray(child.material) ? converted : converted[0];
        }
      }
    });

    // sanitize and validate animations
    const validAnims = [];
    if (Array.isArray(animations)) {
      for (const clip of animations) {
        if (!clip || !Array.isArray(clip.tracks) || clip.tracks.length === 0) continue;
        const matchingTracks = clip.tracks.filter(track => {
          if (!track || !track.name) return false;
          const nodeName = track.name.split('.')[0];
          return !!clone.getObjectByName(nodeName);
        });
        if (matchingTracks.length > 0) {
          try {
            const clonedClip = clip.clone();
            clonedClip.tracks = matchingTracks;
            validAnims.push(clonedClip);
          } catch (e) {}
        }
      }
    }

    const exporter = new GLTFExporter();
    let glbBuffer;

    // export with tolerance for both sync and async failures
    try {
      glbBuffer = await new Promise((resolve, reject) => {
        try {
          exporter.parse(
            clone,
            (res) => resolve(res),
            (err) => reject(err),
            { binary: true, onlyVisible: false, animations: validAnims }
          );
        } catch (syncErr) {
          reject(syncErr);
        }
      });
    } catch (animErr) {
      console.warn(`[${SCRIPT_NAME}] Initial parse failed (${animErr.message}). Retrying a clean static export...`);
      glbBuffer = await new Promise((resolve, reject) => {
        try {
          exporter.parse(
            clone,
            (res) => resolve(res),
            (err) => reject(err),
            { binary: true, onlyVisible: false, animations: [] }
          );
        } catch (staticErr) {
          reject(staticErr);
        }
      });
    }

    const finalBuffer = sanitizeGLB(glbBuffer);
    const safeName = (baseName || 'Kreatem_Asset').replace(/[^a-zA-Z0-9_\-#]/g, '_');
    const filename = `${safeName}_3D.glb`;

    const blob = new Blob([finalBuffer], { type: 'model/gltf-binary' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);

    return filename;
  }

  //PINIA, GAMEWORLD AND SYSTEMS ACCESS
  function getPinia() {
    const appEl = document.getElementById("app");
    if (!appEl) return null;
    return (
      appEl._vnode?.component?.appContext?.config?.globalProperties?.$pinia ||
      appEl.__vue_app__?.config?.globalProperties?.$pinia ||
      appEl._vnode?.component?.appContext?.provides?.pinia ||
      (() => {
        for (const el of document.querySelectorAll('*')) {
          const p = el._vnode?.component?.appContext?.config?.globalProperties?.$pinia || el.__vue_app__?.config?.globalProperties?.$pinia;
          if (p) return p;
        }
        return null;
      })()
    );
  }

  function getGameWorld() {
    if (window.__gameWorld__?.threeScene) return window.__gameWorld__;
    if (window.gameWorld?.threeScene) return window.gameWorld;
    const pinia = getPinia();
    if (pinia && pinia._s) {
      for (const s of pinia._s.values()) {
        if (s?.gameWorld) {
          window.__gameWorld__ = s.gameWorld;
          return s.gameWorld;
        }
      }
    }
    return null;
  }

  // collects all active GameWorld systems
  function getAllSystems(gw) {
    if (!gw?.systemsManager) return [];
    const sm = gw.systemsManager;
    const list = [];
    if (Array.isArray(sm.activeSystems)) list.push(...sm.activeSystems);
    if (Array.isArray(sm.systems)) list.push(...sm.systems);
    if (sm.systems instanceof Map) list.push(...sm.systems.values());
    if (sm.systems instanceof Set) list.push(...sm.systems);
    if (sm.activeSystems instanceof Map) list.push(...sm.activeSystems.values());
    if (sm.activeSystems instanceof Set) list.push(...sm.activeSystems);

    for (const k of Object.keys(sm)) {
      const v = sm[k];
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
        list.push(...v);
      } else if (v instanceof Map && v.size > 0) {
        list.push(...v.values());
      } else if (v instanceof Set && v.size > 0) {
        list.push(...v);
      }
    }
    return Array.from(new Set(list.filter(Boolean)));
  }

  // DETECTION AND MODE EXTRACTION LOGIC

  // MODE 1: HELD ITEM (EQUIPPED)
  function getHeldItem(gw) {
    if (!gw) return null;

    const systems = getAllSystems(gw);

    const armSystem = systems.find(s => s && 'currentBlockId' in s) ||
                      systems.find(s => s && ('itemMesh' in s || 'arms' in s));
    if (armSystem) {

      if (armSystem.musketModel?.visible) {
        return { object: armSystem.musketModel, name: 'Musket' };
      }
      if (armSystem.bowModel?.visible) {
        return { object: armSystem.bowModel, name: 'Bow' };
      }
      if (armSystem.rodModel?.visible) {
        return { object: armSystem.rodModel, name: 'Fishing_Rod' };
      }
      if (armSystem.spyglassModel?.visible) {
        return { object: armSystem.spyglassModel?.root || armSystem.spyglassModel, name: 'Spyglass' };
      }


      const rawMesh = unwrapProxy(armSystem.itemMesh);
      if (rawMesh && (rawMesh.isMesh || rawMesh.isGroup || rawMesh.isObject3D || (rawMesh.children && rawMesh.children.length > 0))) {
        const blockId = armSystem.currentBlockId;
        const itemDef = gw.allItems?.[blockId] || gw.items?.blocks?.[blockId] || gw.items?.tools?.[blockId];
        const itemName = itemDef?.name || itemDef?.title || rawMesh.name || `Item_${blockId}`;
        return { object: rawMesh, name: itemName, id: blockId };
      }
    }

    //third-person view
    if (gw.player?.thirdPersonData?.currItemModel) {
      const tpModel = unwrapProxy(gw.player.thirdPersonData.currItemModel);
      if (tpModel) {
        const handId = gw.player?.currentHandItemId;
        const itemDef = gw.allItems?.[handId] || gw.items?.blocks?.[handId] || gw.items?.tools?.[handId];
        const itemName = itemDef?.name || tpModel.name || 'Held_Item';
        return { object: tpModel, name: itemName, id: handId };
      }
    }

    const playerModel = unwrapProxy(gw.player?.builder?.model || gw.player?.model);
    if (playerModel) {
      const handle = playerModel.getObjectByName('Handle');
      if (handle && handle.children && handle.children.length > 0) {
        const target = unwrapProxy(handle.children[0]);
        const handId = gw.player?.currentHandItemId;
        const itemDef = gw.allItems?.[handId] || gw.items?.blocks?.[handId] || gw.items?.tools?.[handId];
        const itemName = itemDef?.name || target.name || 'Held_Item';
        return { object: target, name: itemName, id: handId };
      }
    }

    return null;
  }

  // MODE 2: RAYCAST (WORLD BLOCKS ONLY)
  function getTargetUnderCrosshair(gw) {
    if (!gw) return null;

    const systems = getAllSystems(gw);

    // direct detection of the highlighted block under the crosshair (BLOCKS_HIGHLIGHTING)
    const highlightSystem = systems.find(s => s && 'currBlockPos' in s);
    if (highlightSystem && highlightSystem.mesh?.visible) {
      const pos = highlightSystem.currBlockPos;
      const blockId = gw.chunkManager?.getBlock(pos.x, pos.y, pos.z);
      if (blockId) {
        const block = gw.chunkManager?.blocks?.[blockId] || gw.items?.blocks?.[blockId];
        const blockName = block?.name || gw.allItems?.[blockId]?.name || `Block_${blockId}`;
        const dist = gw.player?.position ? gw.player.position.distanceTo(pos).toFixed(1) : '?';
        return {
          category: 'Block',
          name: `[Block] ${blockName}`,
          rawName: blockName,
          blockId: blockId,
          coords: { x: pos.x, y: pos.y, z: pos.z },
          distance: dist
        };
      }
    }

    return null;
  }

  // MODE 3: NEARBY ENTITY SELECTOR
  function getNearbyEntities(gw) {
    const list = [];
    if (!gw) return list;

    const systems = getAllSystems(gw);
    const playerPos = gw.player?.position;

    // mobs and creatures (MobsManager / mobIdToMobData)
    const mobsMap = gw.chunkManager?.mobsManagerSystem?.mobIdToMobData ||
                    systems.find(s => s && s.mobIdToMobData)?.mobIdToMobData;
    if (mobsMap) {
      for (const [id, mob] of Object.entries(mobsMap)) {
        const rawModel = unwrapProxy(mob?.model);
        if (rawModel) {
          const mobName = mob.mobRawData?.name || mob.name || `Mob_${id}`;
          const dist = playerPos && rawModel.position ? playerPos.distanceTo(rawModel.position).toFixed(1) : '?';
          
          let animClips = [];
          if (mob.animController?.animMixer?._actions) {
            animClips = mob.animController.animMixer._actions
              .map(a => a?._clip)
              .filter(c => c && Array.isArray(c.tracks) && c.tracks.length > 0);
          }

          list.push({
            type: 'Mob',
            id: `mob_${id}`,
            name: `[Mob] ${mobName} (${dist}m)`,
            rawName: mobName,
            mobKey: mob.mobRawData?.name || mob.name || mobName,
            model: rawModel,
            animations: animClips
          });
        }
      }
    }

    // ground drops (DropItemsSystem / allDropItems)
    const dropSystem = systems.find(s => s && s.allDropItems);
    const dropItems = dropSystem?.allDropItems;
    if (dropItems) {
      for (const [id, item] of Object.entries(dropItems)) {
        const rawMesh = unwrapProxy(item?.mesh);
        if (rawMesh) {
          const dropName = rawMesh.name || `Drop_${id}`;
          const dist = playerPos && item.pos ? playerPos.distanceTo(item.pos).toFixed(1) : '?';
          list.push({
            type: 'Drop',
            id: `drop_${id}`,
            name: `[Drop] ${dropName} (${dist}m)`,
            rawName: dropName,
            model: rawMesh,
            animations: []
          });
        }
      }
    }

    // other players on the server
    if (gw.server?.players && gw.server.players instanceof Map) {
      for (const [id, p] of gw.server.players.entries()) {
        const rawModel = unwrapProxy(p?.builder?.model);
        if (rawModel && p.name) {
          const dist = playerPos && rawModel.position ? playerPos.distanceTo(rawModel.position).toFixed(1) : '?';
          list.push({
            type: 'Player',
            id: `player_${id}`,
            name: `[Player] ${p.name} (${dist}m)`,
            rawName: p.name,
            model: rawModel,
            animations: p.builder?.animations || []
          });
        }
      }
    }

    return list;
  }

  //GRAPHICAL INTERFACE (CMG MINIMALIST FLAT DARK)
  function createUI() {
    const CONTAINER_ID = `${SCRIPT_NAME.toLowerCase()}-container`;
    if (document.getElementById(CONTAINER_ID)) return;

    const container = document.createElement('div');
    container.id = CONTAINER_ID;

    container.innerHTML = `
      <style>
        #${CONTAINER_ID} {
          --cmg-bg: #161512;
          --cmg-panel: #262421;
          --cmg-panel-2: #2f2d2a;
          --cmg-border: #3c3a37;
          --cmg-text: #bababa;
          --cmg-text-strong: #e6e6e6;
          --cmg-muted: #7c7a77;
          --cmg-accent: #3692e7;
          --cmg-accent-hover: #4aa0f0;
          --cmg-success: #22c55e;
          --cmg-error: #cc3333;
          position: fixed;
          top: 60px;
          right: 340px;
          z-index: 9999998;
          font-family: 'Noto Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          user-select: none;
        }
        #${CONTAINER_ID} *,
        #${CONTAINER_ID} *::before,
        #${CONTAINER_ID} *::after {
          box-sizing: border-box;
        }
        .cmg-toggle-btn {
          display: none;
          background: var(--cmg-panel);
          color: var(--cmg-text-strong);
          padding: 7px 12px;
          border-radius: 3px;
          font-size: 13px;
          cursor: pointer;
          border: 1px solid var(--cmg-border);
          align-items: center;
          gap: 6px;
        }
        .cmg-toggle-btn:hover { background: var(--cmg-panel-2); }
        .cmg-window {
          width: 320px;
          background: var(--cmg-bg);
          border: 1px solid var(--cmg-border);
          border-radius: 3px;
          color: var(--cmg-text);
          overflow: hidden;
        }
        .cmg-header {
          padding: 9px 12px;
          background: var(--cmg-panel);
          border-bottom: 1px solid var(--cmg-border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
        }
        .cmg-title-box {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .cmg-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--cmg-muted);
          transition: background 0.3s, box-shadow 0.3s;
          flex-shrink: 0;
        }
        .cmg-dot.active {
          background: var(--cmg-success);
          box-shadow: 0 0 6px #22c55e88;
        }
        .cmg-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--cmg-text-strong);
        }
        .cmg-icon-btn {
          background: transparent;
          border: none;
          color: var(--cmg-muted);
          width: 22px;
          height: 22px;
          border-radius: 3px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          line-height: 1;
        }
        .cmg-icon-btn:hover { background: var(--cmg-panel-2); color: var(--cmg-text-strong); }
        .cmg-body {
          padding: 8px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .cmg-section {
          background: var(--cmg-panel);
          border: 1px solid var(--cmg-border);
          border-radius: 3px;
          padding: 9px;
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .cmg-section-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--cmg-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .cmg-info-row {
          font-size: 12px;
          color: var(--cmg-text-strong);
          background: var(--cmg-bg);
          padding: 6px 8px;
          border-radius: 3px;
          border: 1px solid var(--cmg-border);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .cmg-btn {
          background: var(--cmg-panel-2);
          color: var(--cmg-text-strong);
          border: 1px solid var(--cmg-border);
          border-radius: 3px;
          padding: 7px 12px;
          font-size: 12px;
          font-family: inherit;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: background 0.15s, transform 0.05s;
        }
        .cmg-btn:hover { background: #3a3835; }
        .cmg-btn:active { transform: scale(0.98); }
        .cmg-btn-primary {
          background: var(--cmg-accent);
          border-color: var(--cmg-accent);
          color: #fff;
          font-weight: 600;
        }
        .cmg-btn-primary:hover {
          background: var(--cmg-accent-hover);
          border-color: var(--cmg-accent-hover);
        }
        .cmg-select {
          background: var(--cmg-bg);
          border: 1px solid var(--cmg-border);
          border-radius: 3px;
          color: var(--cmg-text-strong);
          padding: 6px 8px;
          font-size: 12px;
          font-family: inherit;
          outline: none;
          width: 100%;
        }
        .cmg-select:focus { border-color: var(--cmg-accent); }
        .cmg-status {
          font-size: 11px;
          color: var(--cmg-muted);
          padding: 5px 8px;
          background: var(--cmg-panel);
          border-left: 3px solid var(--cmg-border);
          border-radius: 3px;
          word-break: break-word;
        }
        .cmg-status-success { color: var(--cmg-text-strong) !important; border-left-color: var(--cmg-success) !important; }
        .cmg-status-error { color: var(--cmg-text-strong) !important; border-left-color: var(--cmg-error) !important; }
        .cmg-status-loading { color: var(--cmg-text-strong) !important; border-left-color: var(--cmg-accent) !important; }
        .cmg-footer {
          padding: 5px 10px 7px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 9px;
          color: var(--cmg-muted);
          opacity: 0.75;
        }
      </style>

      <div class="cmg-toggle-btn" id="kreatem-toggle-btn">
        <span class="cmg-dot" id="kreatem-btn-dot"></span>
        <span>${SCRIPT_NAME}</span>
      </div>

      <div class="cmg-window" id="kreatem-window">
        <div class="cmg-header" id="kreatem-header">
          <div class="cmg-title-box">
            <span class="cmg-dot" id="kreatem-live-dot"></span>
            <span class="cmg-title">${SCRIPT_NAME}</span>
          </div>
          <button class="cmg-icon-btn" id="kreatem-btn-minimize" title="Minimize">&minus;</button>
        </div>

        <div class="cmg-body">
          <!-- MODE 1: HELD ITEM -->
          <div class="cmg-section">
            <div class="cmg-section-title">
              <span>Held Item (Equipped)</span>
            </div>
            <button class="cmg-btn cmg-btn-primary" id="kreatem-btn-held">
              <span>Download Held Item</span>
            </button>
          </div>

          <!-- MODE 2: RAYCAST (TARGET BLOCK) -->
          <div class="cmg-section">
            <div class="cmg-section-title">
              <span>Crosshair Target (Blocks)</span>
              <span style="font-size: 9px; opacity: 0.8;">Alt + G</span>
            </div>
            <div class="cmg-info-row" id="kreatem-raycast-target">Under crosshair: None</div>
            <button class="cmg-btn cmg-btn-primary" id="kreatem-btn-raycast">
              <span>Download Targeted Block</span>
            </button>
          </div>

          <!-- MODE 3: ENTITY SELECTOR -->
          <div class="cmg-section">
            <div class="cmg-section-title">
              <span id="kreatem-entities-title">Nearby Entities (0)</span>
              <button class="cmg-icon-btn" id="kreatem-btn-refresh" title="Refresh list">&#8635;</button>
            </div>
            <select class="cmg-select" id="kreatem-entity-select">
              <option value="">Select an entity...</option>
            </select>
            <button class="cmg-btn cmg-btn-primary" id="kreatem-btn-dl-entity">
              <span>Download Selected Entity</span>
            </button>
          </div>

          <div class="cmg-status" id="kreatem-status">Ready to export</div>
        </div>

        <div class="cmg-footer">
          <span>${SCRIPT_NAME} v${SCRIPT_VERSION}</span>
          <span>by PIllagerJ88</span>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    loadModules(); // Pre-load 3D modules in the background for instant availability

    //EVENT HANDLING AND ACTIONS
    const winEl = container.querySelector('#kreatem-window');
    const toggleBtn = container.querySelector('#kreatem-toggle-btn');
    const btnMinimize = container.querySelector('#kreatem-btn-minimize');
    const header = container.querySelector('#kreatem-header');
    const statusEl = container.querySelector('#kreatem-status');
    const raycastInfo = container.querySelector('#kreatem-raycast-target');
    const entitySelect = container.querySelector('#kreatem-entity-select');
    const entitiesTitle = container.querySelector('#kreatem-entities-title');

    function setStatus(text, type = '') {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = type ? `cmg-status cmg-status-${type}` : 'cmg-status';
    }

    //restore position and minimized state
    if (settings.minimized) {
      winEl.style.display = 'none';
      toggleBtn.style.display = 'flex';
    }
    if (settings.posX !== null && settings.posY !== null) {
      container.style.right = 'auto';
      container.style.left = `${settings.posX}px`;
      container.style.top = `${settings.posY}px`;
    }

    btnMinimize.addEventListener('click', () => {
      winEl.style.display = 'none';
      toggleBtn.style.display = 'flex';
      settings.minimized = true;
      saveSettings(settings);
    });

    let isDragging = false;
    let hasMoved = false;
    let startX, startY, initLeft, initTop;

    function startDrag(e) {
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = container.getBoundingClientRect();
      initLeft = rect.left;
      initTop = rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('#kreatem-btn-minimize')) return;
      startDrag(e);
    });

    toggleBtn.addEventListener('mousedown', (e) => {
      startDrag(e);
    });

    toggleBtn.addEventListener('click', (e) => {
      if (hasMoved) return;
      winEl.style.display = 'block';
      toggleBtn.style.display = 'none';
      settings.minimized = false;
      saveSettings(settings);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMoved = true;
      }
      const rect = container.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const newLeft = Math.max(0, Math.min(maxLeft, initLeft + dx));
      const newTop = Math.max(0, Math.min(maxTop, initTop + dy));
      container.style.right = 'auto';
      container.style.left = `${newLeft}px`;
      container.style.top = `${newTop}px`;
      settings.posX = newLeft;
      settings.posY = newTop;
    }

    function onMouseUp() {
      if (isDragging) {
        isDragging = false;
        saveSettings(settings);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
    }

    // local entity cache
    let cachedEntities = [];
    let currentCrosshairTarget = null;

    function updateEntityDropdown() {
      const gw = getGameWorld();
      if (!gw) {
        if (entitySelect) entitySelect.innerHTML = '<option value="">You are not in a match</option>';
        if (entitiesTitle) entitiesTitle.textContent = 'Nearby Entities (0)';
        return;
      }

      cachedEntities = getNearbyEntities(gw);
      if (entitiesTitle) entitiesTitle.textContent = `Nearby Entities (${cachedEntities.length})`;

      const currentVal = entitySelect.value;
      entitySelect.innerHTML = '<option value="">Select an entity...</option>';

      cachedEntities.forEach(ent => {
        const opt = document.createElement('option');
        opt.value = ent.id;
        opt.textContent = ent.name;
        if (ent.id === currentVal) opt.selected = true;
        entitySelect.appendChild(opt);
      });
    }

    container.querySelector('#kreatem-btn-refresh').addEventListener('click', () => {
      updateEntityDropdown();
      setStatus("Entity list updated.", "loading");
      setTimeout(() => setStatus("Ready to export"), 1000);
    });

    // ACTION 1: DOWNLOAD HELD ITEM
    container.querySelector('#kreatem-btn-held').addEventListener('click', async () => {
      try {
        const gw = getGameWorld();
        if (!gw) throw new Error("You must be in a match to export the held item.");

        setStatus("Looking for the equipped item...", "loading");
        const held = getHeldItem(gw);
        if (!held || !held.object) throw new Error("You have no item equipped in your hand (empty hand).");

        setStatus(`Exporting ${held.name}...`, "loading");
        const filename = await exportObjectToGLB(held.object, held.name);
        setStatus(`Downloaded: ${filename}`, "success");
      } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, "error");
      }
    });

    // ACTION 2: DOWNLOAD TARGETED BLOCK (RAYCAST)
    async function triggerRaycastDownload() {
      try {
        const gw = getGameWorld();
        if (!gw) throw new Error("You must be in an active match.");

        await loadModules();

        const target = currentCrosshairTarget || getTargetUnderCrosshair(gw);
        if (!target) throw new Error("There is no block under the crosshair.");

        setStatus(`Preparing download of ${target.rawName}...`, "loading");

        if (target.category === 'Block' && target.blockId) {
          const systems = getAllSystems(gw);
          const armSystem = systems.find(s => s && s.createItemMesh && s.arms);

          // if the block is part of a multi block structure (such as a portal, bed...),
          // target its mainBlockId to generate the complete structure in 3D
          const blockDef = gw.chunkManager?.blocks?.[target.blockId] || gw.allItems?.[target.blockId];
          const targetBlockId = (blockDef && blockDef.structureInfo && blockDef.structureInfo.mainBlockId)
            ? blockDef.structureInfo.mainBlockId
            : target.blockId;

          let blockMesh = null;
          if (armSystem) {
            const prevHandId = armSystem.currentBlockId ?? gw.player?.currentHandItemId;
            try {
              armSystem.currentBlockId = targetBlockId;
              await armSystem.createItemMesh(targetBlockId);
              if (armSystem.itemMesh) {
                blockMesh = armSystem.itemMesh.clone(true);
              }
            } catch (meshErr) {
              console.warn(`[${SCRIPT_NAME}] Failed to generate the mesh through armSystem:`, meshErr);
            } finally {
              try {
                armSystem.currentBlockId = prevHandId;
                if (prevHandId) {
                  await armSystem.createItemMesh(prevHandId);
                } else {
                  armSystem.removeItemMesh();
                }
              } catch (e) {}
            }
          }

          // if armSystem produced the exact mesh with UV coordinates from the texture atlas
          if (blockMesh) {
            const filename = await exportObjectToGLB(blockMesh, target.rawName);
            setStatus(`Downloaded: ${filename}`, "success");
            return;
          }

          throw new Error(`Could not generate the mesh for block ${target.rawName}.`);
        }

        throw new Error("Could not get the geometry of the block under the crosshair.");
      } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, "error");
      }
    }

    container.querySelector('#kreatem-btn-raycast').addEventListener('click', triggerRaycastDownload);

    // Alt + G keyboard shortcut for Raycast
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === settings.hotkeyRaycast) {
        e.preventDefault();
        triggerRaycastDownload();
      }
    });

    // ACTION 3: DOWNLOAD SELECTED ENTITY
    container.querySelector('#kreatem-btn-dl-entity').addEventListener('click', async () => {
      try {
        const selectedId = entitySelect.value;
        if (!selectedId) throw new Error("Select an entity from the list.");

        const ent = cachedEntities.find(e => e.id === selectedId);
        if (!ent) throw new Error("The selected entity is no longer available.");

        setStatus(`Preparing download of ${ent.rawName}...`, "loading");

        // if it is a mob, try to download the official asset from $assetsUrls
        if (ent.type === 'Mob') {
          const assetUrl = findMobAssetUrl(ent.rawName || ent.mobKey);
          if (assetUrl) {
            setStatus(`Downloading official asset for ${ent.rawName}...`, "loading");
            try {
              const res = await fetch(assetUrl);
              if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();
                const cleanBuffer = sanitizeGLB(arrayBuffer);
                const safeName = (ent.rawName || 'Mob').replace(/[^a-zA-Z0-9_\-#]/g, '_');
                const filename = `${safeName}_3D.glb`;

                const blob = new Blob([cleanBuffer], { type: 'model/gltf-binary' });
                const downloadUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(downloadUrl);

                setStatus(`Downloaded: ${filename}`, "success");
                return;
              }
            } catch (fetchErr) {
              console.warn(`[${SCRIPT_NAME}] Direct asset download failed (${fetchErr.message}). Falling back to the Three.js exporter...`);
            }
          }
        }

        // hardened export from the live Three.js scene
        if (!ent.model) throw new Error("The selected entity has no active 3D model.");
        setStatus(`Exporting ${ent.rawName}...`, "loading");
        const filename = await exportObjectToGLB(ent.model, ent.rawName, ent.animations || []);
        setStatus(`Downloaded: ${filename}`, "success");
      } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, "error");
      }
    });

    // live loop for raycast and the status LED
    setInterval(() => {
      try {
        const gw = getGameWorld();
        const liveDot = container.querySelector('#kreatem-live-dot');
        const btnDot = container.querySelector('#kreatem-btn-dot');
        const isOnline = !!(gw && (gw.threeScene || gw.player || gw.chunkManager));

        if (liveDot) {
          if (isOnline) liveDot.classList.add('active');
          else liveDot.classList.remove('active');
        }
        if (btnDot) {
          if (isOnline) btnDot.classList.add('active');
          else btnDot.classList.remove('active');
        }

        if (isOnline && winEl.style.display !== 'none') {
          const hit = getTargetUnderCrosshair(gw);
          currentCrosshairTarget = hit;
          if (hit) {
            raycastInfo.textContent = `Under crosshair: ${hit.name} (${hit.distance}m)`;
          } else {
            raycastInfo.textContent = 'Under crosshair: None';
          }
        }
      } catch (e) {}
    }, 400);

    // periodic auto refresh of the entity dropdown
    setInterval(() => {
      const gw = getGameWorld();
      const isOnline = !!(gw && (gw.threeScene || gw.player || gw.chunkManager));
      if (isOnline && winEl.style.display !== 'none' && document.activeElement !== entitySelect) {
        updateEntityDropdown();
      }
    }, 2500);
  }

  // INITIALIZATION
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    createUI();
  } else {
    window.addEventListener('DOMContentLoaded', createUI);
  }
})();