/**
 * Avatar 3D do LibrasLive.
 *
 * Por padrão usa um humanoide PROCEDURAL construído com Three.js: ossos
 * nomeados (Hips → Spine → Chest → Neck → Head e os dois braços), malhas
 * de cápsulas/esferas, sobrancelhas, olhos, boca e dedos articulados.
 *
 * Evolução: passe `modelUrl` com um GLB humanoide com rig mixamo-compatible.
 * O carregador procura ossos pelo nome (aceita prefixos como "mixamorig")
 * e aplica `morphTargetInfluences` pelas chaves ARKit do contrato 6.1.
 * Se o download falhar, volta automaticamente ao Avatar procedural.
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { BoneName } from "../types";
import type { AnimationQueue } from "./AnimationQueue";
import { BONE_NAMES, clamp01, neutralFrame, type PoseFrame } from "./retarget";

export type AvatarProps = {
  queue: AnimationQueue;
  /** GLB humanoide com ossos mixamo-compatible; ausente = humanoide procedural */
  modelUrl?: string;
  reducedMotion?: boolean;
};

type FrameRef = MutableRefObject<PoseFrame>;

const PELE = "#e8b89a";
const PELE_SOMBRA = "#d9a584";
const CABELO = "#2b2233";
const OLHO = "#f8fafc";
const IRIS = "#334155";
const PUPILA = "#0f172a";
const BOCA = "#7f3b46";
const CAMISA = "#2f6f8f";
const CAMISA_CLARA = "#3d86a8";
const CALCA = "#26364d";

/** Padrões de dedo para datilologia: '1' = dobrado, '0' = estendido. */
const PADROES_LETRA: Record<string, string> = {
  A: "01110", B: "01111", C: "00010", D: "01100", E: "00110",
  F: "11000", G: "10000", H: "10001", I: "00001", J: "00011",
  K: "10100", L: "10010", M: "11100", N: "11000", O: "00000",
  P: "11010", Q: "11011", R: "01010", S: "00100", T: "00101",
  U: "00110", V: "00110", W: "01110", X: "11110", Y: "10101",
  Z: "11001",
};

function curlsPara(config: string | null): number[] {
  if (!config) return [0.08, 0.08, 0.08, 0.08, 0.05];
  const upper = config.toUpperCase();
  if (upper === "MAO-PLANA" || upper === "MÃO-PLANA" || upper === "PLANA") {
    return [0, 0, 0, 0, 0];
  }
  if (upper === "PINO") return [0, 1.15, 0.08, 0.08, 0.6];
  if (upper === "GARRA") return [1.05, 1.05, 1.05, 1.05, 0.8];
  if (upper.length === 1 && PADROES_LETRA[upper]) {
    return PADROES_LETRA[upper].split("").map((bit) => (bit === "1" ? 1.15 : 0.08));
  }
  return [0.35, 0.35, 0.35, 0.35, 0.25];
}

/** Avança a fila uma única vez por frame; todos os avatares apenas leem. */
function FrameDriver({ queue, frameRef }: { queue: AnimationQueue; frameRef: FrameRef }): null {
  useFrame((_, delta) => {
    frameRef.current = queue.advance(delta * 1000);
  });
  return null;
}

type HandProps = {
  side: 1 | -1;
  register: (key: string, node: THREE.Group | null) => void;
};

function Hand({ side, register }: HandProps) {
  const dedos = [-0.045, -0.015, 0.015, 0.045];
  return (
    <group>
      <mesh castShadow position={[0, -0.02, 0]}>
        <boxGeometry args={[0.115, 0.125, 0.038]} />
        <meshStandardMaterial color={PELE} roughness={0.65} />
      </mesh>
      {dedos.map((x, indice) => (
        <group
          key={indice}
          ref={(no) => register(`${side}-${indice}`, no)}
          position={[x * side, -0.085, 0]}
        >
          <mesh castShadow position={[0, -0.045, 0]}>
            <capsuleGeometry args={[0.011, 0.07, 4, 8]} />
            <meshStandardMaterial color={PELE} roughness={0.6} />
          </mesh>
        </group>
      ))}
      <group
        ref={(no) => register(`${side}-thumb`, no)}
        position={[0.07 * side, -0.015, 0.012]}
        rotation={[0, 0, -0.55 * side]}
      >
        <mesh castShadow position={[0, -0.04, 0]}>
          <capsuleGeometry args={[0.014, 0.055, 4, 8]} />
          <meshStandardMaterial color={PELE} roughness={0.6} />
        </mesh>
      </group>
    </group>
  );
}

type ProceduralAvatarProps = {
  frameRef: FrameRef;
  reducedMotion: boolean;
};

function ProceduralAvatar({ frameRef, reducedMotion }: ProceduralAvatarProps) {
  const bones = useRef<Partial<Record<BoneName, THREE.Group | null>>>({});
  const dedos = useRef<Record<string, THREE.Group | null>>({});
  const root = useRef<THREE.Group>(null);
  const sobrancelhaL = useRef<THREE.Group>(null);
  const sobrancelhaR = useRef<THREE.Group>(null);
  const olhoL = useRef<THREE.Group>(null);
  const olhoR = useRef<THREE.Group>(null);
  const pupilaL = useRef<THREE.Mesh>(null);
  const pupilaR = useRef<THREE.Mesh>(null);
  const boca = useRef<THREE.Mesh>(null);
  const cantoL = useRef<THREE.Mesh>(null);
  const cantoR = useRef<THREE.Mesh>(null);
  const bochechaL = useRef<THREE.Mesh>(null);
  const bochechaR = useRef<THREE.Mesh>(null);

  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const tmpEuler = useMemo(() => new THREE.Euler(), []);
  const tmpIdle = useMemo(() => new THREE.Quaternion(), []);
  const tmpIdleHead = useMemo(() => new THREE.Quaternion(), []);
  const ultimaConfig = useRef<string>("");

  const setBone = (nome: BoneName) => (no: THREE.Group | null) => {
    bones.current[nome] = no;
  };
  const setDedos = (chave: string, no: THREE.Group | null) => {
    dedos.current[chave] = no;
  };

  useFrame((state, delta) => {
    const frame = frameRef.current;
    const suavizacao = 1 - Math.exp(-delta * (reducedMotion ? 28 : 13));

    for (const nome of BONE_NAMES) {
      const grupo = bones.current[nome];
      if (!grupo) continue;
      tmpQuat.set(...frame.bones[nome]);
      grupo.quaternion.slerp(tmpQuat, suavizacao);
    }

    const tempo = state.clock.elapsedTime;
    if (root.current) root.current.position.y = -1.02;

    if (!reducedMotion && frame.isIdle && root.current) {
      root.current.position.y += Math.sin(tempo * 1.5) * 0.012;
      tmpEuler.set(0, Math.sin(tempo * 0.7) * 0.035, Math.sin(tempo * 0.9) * 0.02);
      bones.current.Spine?.quaternion.multiply(tmpIdle.setFromEuler(tmpEuler));
      tmpEuler.set(Math.sin(tempo * 0.6) * 0.025, Math.sin(tempo * 0.45) * 0.05, Math.sin(tempo * 0.8) * 0.025);
      bones.current.Head?.quaternion.multiply(tmpIdleHead.setFromEuler(tmpEuler));
    }

    const bs = frame.blendshapes;
    const erguida = clamp01(
      (bs.browInnerUp ?? 0) * 0.55 + ((bs.browOuterUp_L ?? 0) + (bs.browOuterUp_R ?? 0)) * 0.225,
    );
    const franzida = clamp01(((bs.browDown_L ?? 0) + (bs.browDown_R ?? 0)) * 0.5);
    if (sobrancelhaL.current) {
      sobrancelhaL.current.position.y = 0.235 + erguida * 0.055 - franzida * 0.018;
      sobrancelhaL.current.rotation.z = 0.07 + franzida * 0.4;
      sobrancelhaL.current.scale.y = 1 + franzida * 0.5;
    }
    if (sobrancelhaR.current) {
      sobrancelhaR.current.position.y = 0.235 + erguida * 0.055 - franzida * 0.018;
      sobrancelhaR.current.rotation.z = -0.07 - franzida * 0.4;
      sobrancelhaR.current.scale.y = 1 + franzida * 0.5;
    }

    const piscarL = clamp01(bs.eyeBlink_L ?? 0);
    const piscarR = clamp01(bs.eyeBlink_R ?? 0);
    if (olhoL.current) olhoL.current.scale.y = 1 - piscarL * 0.93;
    if (olhoR.current) olhoR.current.scale.y = 1 - piscarR * 0.93;
    if (pupilaL.current) pupilaL.current.position.x = reducedMotion ? 0 : Math.sin(tempo * 0.5) * 0.004;
    if (pupilaR.current) pupilaR.current.position.x = reducedMotion ? 0 : Math.sin(tempo * 0.5) * 0.004;

    const sorriso = clamp01(((bs.mouthSmile_L ?? 0) + (bs.mouthSmile_R ?? 0)) * 0.5);
    const frustre = clamp01(((bs.mouthFrown_L ?? 0) + (bs.mouthFrown_R ?? 0)) * 0.5);
    const maxilar = clamp01(bs.jawOpen ?? 0);
    if (boca.current) {
      boca.current.scale.set(
        1 + sorriso * 0.3 - frustre * 0.08,
        0.28 * (1 + maxilar * 2.4 + frustre * 0.2),
        0.4,
      );
      boca.current.position.y = -0.035 - maxilar * 0.035;
    }
    if (cantoL.current) cantoL.current.position.y = -0.018 + sorriso * 0.022 - frustre * 0.018;
    if (cantoR.current) cantoR.current.position.y = -0.018 + sorriso * 0.022 - frustre * 0.018;
    const inchaco = clamp01(bs.cheekPuff ?? 0);
    const escalaBochecha = 1 + inchaco * 0.35;
    if (bochechaL.current) bochechaL.current.scale.set(escalaBochecha, 0.7 * escalaBochecha, 0.5 * escalaBochecha);
    if (bochechaR.current) bochechaR.current.scale.set(escalaBochecha, 0.7 * escalaBochecha, 0.5 * escalaBochecha);

    const config = frame.dedo ?? frame.classificador ?? "";
    if (config !== ultimaConfig.current) {
      ultimaConfig.current = config;
      const curls = curlsPara(config || null);
      for (let indice = 0; indice < 4; indice += 1) {
        for (const side of [1, -1]) {
          const grupo = dedos.current[`${side}-${indice}`];
          if (grupo) grupo.rotation.x = -curls[indice];
        }
      }
      for (const side of [1, -1]) {
        const polegar = dedos.current[`${side}-thumb`];
        if (polegar) polegar.rotation.x = -curls[4] * 0.8;
      }
    }
  });

  return (
    <group ref={root} position={[0, -1.02, 0]}>
      {/* Pernas — fora do contrato de ossos, apenas silhueta */}
      {([-1, 1] as const).map((lado) => (
        <group key={lado} position={[0.12 * lado, -0.16, 0]}>
          <mesh castShadow position={[0, -0.22, 0]}>
            <capsuleGeometry args={[0.095, 0.34, 6, 12]} />
            <meshStandardMaterial color={CALCA} roughness={0.9} />
          </mesh>
          <mesh castShadow position={[0, -0.62, 0]}>
            <capsuleGeometry args={[0.075, 0.28, 6, 12]} />
            <meshStandardMaterial color={CALCA} roughness={0.9} />
          </mesh>
          <mesh castShadow position={[0, -0.86, 0.07]}>
            <boxGeometry args={[0.15, 0.07, 0.26]} />
            <meshStandardMaterial color="#1c2738" roughness={0.85} />
          </mesh>
        </group>
      ))}

      <group name="Hips" ref={setBone("Hips")}>
        <mesh castShadow>
          <capsuleGeometry args={[0.185, 0.1, 6, 14]} />
          <meshStandardMaterial color={CALCA} roughness={0.9} />
        </mesh>

        <group name="Spine" position={[0, 0.28, 0]} ref={setBone("Spine")}>
          <mesh castShadow position={[0, 0.17, 0]}>
            <capsuleGeometry args={[0.2, 0.24, 6, 14]} />
            <meshStandardMaterial color={CAMISA} roughness={0.75} />
          </mesh>

          <group name="Chest" position={[0, 0.4, 0]} ref={setBone("Chest")}>
            <mesh castShadow position={[0, 0.05, 0]}>
              <capsuleGeometry args={[0.255, 0.13, 6, 16]} />
              <meshStandardMaterial color={CAMISA_CLARA} roughness={0.72} />
            </mesh>
            <mesh position={[0, 0.1, 0.2]}>
              <boxGeometry args={[0.05, 0.16, 0.02]} />
              <meshStandardMaterial color="#8ecae6" roughness={0.6} />
            </mesh>

            <group name="Neck" position={[0, 0.34, 0]} ref={setBone("Neck")}>
              <mesh castShadow position={[0, 0.08, 0]}>
                <cylinderGeometry args={[0.07, 0.08, 0.18, 12]} />
                <meshStandardMaterial color={PELE_SOMBRA} roughness={0.7} />
              </mesh>

              <group name="Head" position={[0, 0.24, 0]} ref={setBone("Head")}>
                <mesh castShadow position={[0, 0.1, 0]} scale={[1, 1.12, 0.92]}>
                  <sphereGeometry args={[0.23, 28, 20]} />
                  <meshStandardMaterial color={PELE} roughness={0.62} />
                </mesh>
                <mesh castShadow position={[0, 0.13, -0.012]} scale={[1.02, 1.04, 0.96]}>
                  <sphereGeometry args={[0.232, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.52]} />
                  <meshStandardMaterial color={CABELO} roughness={0.95} />
                </mesh>
                {([-1, 1] as const).map((lado) => (
                  <mesh key={lado} castShadow position={[0.228 * lado, 0.09, 0]}>
                    <sphereGeometry args={[0.035, 12, 10]} />
                    <meshStandardMaterial color={PELE_SOMBRA} roughness={0.7} />
                  </mesh>
                ))}
                <mesh position={[0, 0.05, 0.218]} rotation={[Math.PI / 2, 0, 0]}>
                  <coneGeometry args={[0.026, 0.065, 10]} />
                  <meshStandardMaterial color={PELE_SOMBRA} roughness={0.7} />
                </mesh>

                {/* Olhos: grupo inteiro é escalado para piscar */}
                {([[-1, olhoL, pupilaL], [1, olhoR, pupilaR]] as const).map(([lado, grupo, pupila]) => (
                  <group key={lado} ref={grupo} position={[0.088 * lado, 0.15, 0.188]}>
                    <mesh scale={[1, 0.88, 0.55]}>
                      <sphereGeometry args={[0.048, 18, 14]} />
                      <meshStandardMaterial color={OLHO} roughness={0.35} />
                    </mesh>
                    <mesh ref={pupila} position={[0, 0, 0.028]} scale={[1, 1, 0.5]}>
                      <sphereGeometry args={[0.024, 14, 12]} />
                      <meshStandardMaterial color={IRIS} roughness={0.3} />
                    </mesh>
                    <mesh position={[0, 0, 0.035]} scale={[1, 1, 0.5]}>
                      <sphereGeometry args={[0.011, 12, 10]} />
                      <meshStandardMaterial color={PUPILA} roughness={0.25} />
                    </mesh>
                  </group>
                ))}

                {/* Sobrancelhas */}
                <group ref={sobrancelhaL} position={[-0.088, 0.235, 0.201]} rotation={[0, 0, 0.07]}>
                  <mesh castShadow>
                    <boxGeometry args={[0.11, 0.019, 0.022]} />
                    <meshStandardMaterial color={CABELO} roughness={0.95} />
                  </mesh>
                </group>
                <group ref={sobrancelhaR} position={[0.088, 0.235, 0.201]} rotation={[0, 0, -0.07]}>
                  <mesh castShadow>
                    <boxGeometry args={[0.11, 0.019, 0.022]} />
                    <meshStandardMaterial color={CABELO} roughness={0.95} />
                  </mesh>
                </group>

                {/* Boca e cantos */}
                <mesh ref={boca} position={[0, -0.035, 0.207]} scale={[1, 0.28, 0.4]}>
                  <sphereGeometry args={[0.058, 18, 12]} />
                  <meshStandardMaterial color={BOCA} roughness={0.6} />
                </mesh>
                {([[cantoL, -1], [cantoR, 1]] as const).map(([ref, lado]) => (
                  <mesh key={lado} ref={ref} position={[0.05 * lado, -0.018, 0.207]}>
                    <sphereGeometry args={[0.011, 10, 8]} />
                    <meshStandardMaterial color={PELE_SOMBRA} roughness={0.7} />
                  </mesh>
                ))}
                {([[bochechaL, -1], [bochechaR, 1]] as const).map(([ref, lado]) => (
                  <mesh key={lado} ref={ref} position={[0.135 * lado, 0.015, 0.17]} scale={[1, 0.7, 0.5]}>
                    <sphereGeometry args={[0.045, 12, 10]} />
                    <meshStandardMaterial color="#e8a6a0" transparent opacity={0.35} roughness={0.8} />
                  </mesh>
                ))}
              </group>
            </group>

            {/* Braços espelhados:.Left = +X, Right = -X */}
            {([["LeftArm", "LeftForeArm", "LeftHand", 1], ["RightArm", "RightForeArm", "RightHand", -1]] as const).map(
              ([nomeBraco, nomeAntebraco, nomeMao, lado]) => (
                <group
                  key={nomeBraco}
                  name={nomeBraco}
                  position={[0.315 * lado, 0.21, 0]}
                  ref={setBone(nomeBraco)}
                >
                  <mesh castShadow position={[0, -0.17, 0]}>
                    <capsuleGeometry args={[0.076, 0.22, 6, 12]} />
                    <meshStandardMaterial color={CAMISA_CLARA} roughness={0.75} />
                  </mesh>
                  <mesh castShadow position={[0, -0.33, 0]}>
                    <sphereGeometry args={[0.078, 12, 10]} />
                    <meshStandardMaterial color={PELE} roughness={0.65} />
                  </mesh>

                  <group name={nomeAntebraco} position={[0, -0.35, 0]} ref={setBone(nomeAntebraco)}>
                    <mesh castShadow position={[0, -0.14, 0]}>
                      <capsuleGeometry args={[0.064, 0.2, 6, 12]} />
                      <meshStandardMaterial color={PELE} roughness={0.65} />
                    </mesh>
                    <group name={nomeMao} position={[0, -0.29, 0]} ref={setBone(nomeMao)}>
                      <Hand side={lado} register={setDedos} />
                    </group>
                  </group>
                </group>
              ),
            )}
          </group>
        </group>
      </group>
    </group>
  );
}

type GLBAvatarProps = {
  url: string;
  reducedMotion: boolean;
  frameRef: FrameRef;
};

function GLBAvatar({ url, reducedMotion, frameRef }: GLBAvatarProps) {
  const [cena, setCena] = useState<THREE.Group | null>(null);
  const [falhou, setFalhou] = useState(false);
  const mapaOssos = useMemo(() => new Map<BoneName, THREE.Object3D>(), []);
  const mapaMorphs = useMemo(() => new Map<string, THREE.Mesh[]>(), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);

  useEffect(() => {
    let cancelado = false;
    setCena(null);
    setFalhou(false);
    mapaOssos.clear();
    mapaMorphs.clear();

    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (cancelado) return;
        gltf.scene.traverse((objeto) => {
          const malha = objeto as THREE.Mesh;
          if (malha.isMesh) {
            malha.castShadow = true;
            malha.receiveShadow = true;
            if (malha.morphTargetDictionary) {
              for (const chave of Object.keys(malha.morphTargetDictionary)) {
                const lista = mapaMorphs.get(chave) ?? [];
                lista.push(malha);
                mapaMorphs.set(chave, lista);
              }
            }
          }
          for (const nome of BONE_NAMES) {
            if (!mapaOssos.has(nome) && (objeto.name === nome || objeto.name.endsWith(nome))) {
              mapaOssos.set(nome, objeto);
            }
          }
        });
        setCena(gltf.scene);
      },
      undefined,
      () => {
        if (!cancelado) setFalhou(true);
      },
    );

    return () => {
      cancelado = true;
    };
  }, [url, mapaOssos, mapaMorphs]);

  useFrame((_, delta) => {
    if (!cena) return;
    const frame = frameRef.current;
    const suavizacao = 1 - Math.exp(-delta * (reducedMotion ? 28 : 13));

    for (const nome of BONE_NAMES) {
      const osso = mapaOssos.get(nome);
      if (!osso) continue;
      tmpQuat.set(...frame.bones[nome]);
      osso.quaternion.slerp(tmpQuat, suavizacao);
    }

    for (const [chave, valor] of Object.entries(frame.blendshapes)) {
      const malhas = mapaMorphs.get(chave);
      if (!malhas) continue;
      for (const malha of malhas) {
        const dicionario = malha.morphTargetDictionary;
        const influencias = malha.morphTargetInfluences;
        if (!dicionario || !influencias) continue;
        const indice = dicionario[chave];
        if (typeof indice === "number" && indice < influencias.length) influencias[indice] = valor;
      }
    }
  });

  if (falhou || !cena) return <ProceduralAvatar frameRef={frameRef} reducedMotion={reducedMotion} />;
  return <primitive object={cena} position={[0, -1.02, 0]} />;
}

export function Avatar({ queue, modelUrl, reducedMotion = false }: AvatarProps) {
  const frameRef = useRef<PoseFrame>(neutralFrame());

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [0, -0.32, 3.25], fov: 34, near: 0.1, far: 50 }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.15;
      }}
      style={{ width: "100%", height: "100%", background: "transparent" }}
    >
      <FrameDriver queue={queue} frameRef={frameRef} />

      <ambientLight intensity={0.75} />
      <hemisphereLight args={["#dbeafe", "#1e293b", 0.55]} />
      <directionalLight
        position={[2.6, 4.2, 3.2]}
        intensity={1.7}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={0.5}
        shadow-camera-far={12}
        shadow-camera-left={-3}
        shadow-camera-right={3}
        shadow-camera-top={3}
        shadow-camera-bottom={-3}
        shadow-bias={-0.001}
      />
      <pointLight position={[-2.4, 1.6, -2]} intensity={1.1} color="#7dd3fc" distance={9} />
      <pointLight position={[2.2, -0.4, 1.8]} intensity={0.5} color="#fbbf24" distance={6} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.02, 0]} receiveShadow>
        <planeGeometry args={[3.2, 2.4]} />
        <shadowMaterial transparent opacity={0.26} />
      </mesh>

      {modelUrl ? (
        <GLBAvatar url={modelUrl} reducedMotion={reducedMotion} frameRef={frameRef} />
      ) : (
        <ProceduralAvatar frameRef={frameRef} reducedMotion={reducedMotion} />
      )}
    </Canvas>
  );
}
