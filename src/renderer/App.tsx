/** Raiz do renderer: overlay flutuante, fundo transparente e integração do pipeline. */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Avatar } from "./avatar/Avatar";
import { AnimationQueue, type QueueProgress } from "./avatar/AnimationQueue";
import { DEMO_POSE_MAP } from "./avatar/fixtures";
import { CONFIG_PADRAO, librasHost } from "./host";
import { Controls } from "./ui/Controls";
import { useGlossStream } from "./useGlossStream";
import type { PanelConfig } from "./types";
import "./styles.css";

function origemEscala(canto: PanelConfig["canto"]): string {
  const vertical = canto.startsWith("superior") ? "top" : "bottom";
  const horizontal = canto.endsWith("direito") ? "right" : "left";
  return `${vertical} ${horizontal}`;
}

export function App() {
  const [tamanho, setTamanho] = useState(CONFIG_PADRAO.tamanho);
  const [opacidade, setOpacidade] = useState(CONFIG_PADRAO.opacidade);
  const [canto, setCanto] = useState<PanelConfig["canto"]>(CONFIG_PADRAO.canto);
  const [alwaysOnTop, setAlwaysOnTop] = useState(CONFIG_PADRAO.alwaysOnTop);
  const [reducedMotion, setReducedMotion] = useState(false);

  const stream = useGlossStream();
  const queueRef = useRef<AnimationQueue | null>(null);
  if (!queueRef.current) queueRef.current = new AnimationQueue();
  const queue = queueRef.current;

  const [progress, setProgress] = useState<QueueProgress>(() => queue.progress);
  const arrastando = useRef<{ x: number; y: number } | null>(null);
  /** Evita que o primeiro render sobrescreva a config salva antes do getConfig. */
  const configCarregada = useRef(false);

  useEffect(() => queue.subscribe(setProgress), [queue]);

  useEffect(() => {
    queue.setLexicon({ ...DEMO_POSE_MAP, ...stream.poses });
  }, [queue, stream.poses]);

  useEffect(() => {
    if (stream.gloss) queue.enqueue(stream.gloss);
  }, [queue, stream.gloss]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const atualizar = () => {
      setReducedMotion(media.matches);
      queue.setReducedMotion(media.matches);
    };
    atualizar();
    media.addEventListener("change", atualizar);
    return () => media.removeEventListener("change", atualizar);
  }, [queue]);

  useEffect(() => {
    let ativo = true;
    librasHost.getConfig()
      .then((config) => {
        if (!ativo || !config) return;
        setTamanho(config.tamanho);
        setOpacidade(config.opacidade);
        setCanto(config.canto);
        setAlwaysOnTop(config.alwaysOnTop);
      })
      .catch(() => undefined)
      .finally(() => {
        if (ativo) configCarregada.current = true;
      });
    return () => {
      ativo = false;
    };
  }, []);

  useEffect(() => {
    if (!configCarregada.current) return;
    librasHost.setConfig({ tamanho, opacidade, canto, alwaysOnTop });
  }, [tamanho, opacidade, canto, alwaysOnTop]);

  useEffect(() => {
    librasHost.setAlwaysOnTop(alwaysOnTop);
  }, [alwaysOnTop]);

  const aoPular = useCallback(() => queue.next(), [queue]);
  const aoMinimizar = useCallback(() => librasHost.minimize(), []);
  const aoFechar = useCallback(() => librasHost.close(), []);

  const aoPointerDown = useCallback((evento: PointerEvent<HTMLDivElement>) => {
    arrastando.current = { x: evento.clientX, y: evento.clientY };
    evento.currentTarget.setPointerCapture(evento.pointerId);
  }, []);

  const aoPointerMove = useCallback((evento: PointerEvent<HTMLDivElement>) => {
    const anterior = arrastando.current;
    if (!anterior) return;
    const deltaX = evento.clientX - anterior.x;
    const deltaY = evento.clientY - anterior.y;
    arrastando.current = { x: evento.clientX, y: evento.clientY };
    librasHost.drag(deltaX, deltaY);
  }, []);

  const aoPointerUp = useCallback((evento: PointerEvent<HTMLDivElement>) => {
    arrastando.current = null;
    if (evento.currentTarget.hasPointerCapture(evento.pointerId)) {
      evento.currentTarget.releasePointerCapture(evento.pointerId);
    }
  }, []);

  const estiloPainel: CSSProperties = {
    transform: `scale(${tamanho})`,
    transformOrigin: origemEscala(canto),
  };
  const estiloRaiz: CSSProperties = { opacity: opacidade };
  const texto = stream.partial || stream.textoFinal;

  return (
    <div className={`ll-app ll-canto-${canto}`} style={estiloRaiz}>
      <div className="ll-painel" style={estiloPainel}>
        <div
          className="ll-cabecalho"
          onPointerDown={aoPointerDown}
          onPointerMove={aoPointerMove}
          onPointerUp={aoPointerUp}
          onPointerCancel={aoPointerUp}
        >
          <span className="ll-marca">
            <span className="ll-marca-icone" aria-hidden="true">✋</span>
            LibrasLive
          </span>
          <span className="ll-arraste" title="Arraste para mover o painel" aria-hidden="true">⠿</span>
        </div>

        <div className="ll-palco">
          <Avatar queue={queue} reducedMotion={reducedMotion} />
          <div className="ll-vignette" aria-hidden="true" />
        </div>

        <Controls
          tamanho={tamanho}
          opacidade={opacidade}
          canto={canto}
          alwaysOnTop={alwaysOnTop}
          status={stream.status}
          progress={progress}
          texto={texto}
          versaoLexicon={stream.versaoLexicon}
          onTamanho={setTamanho}
          onOpacidade={setOpacidade}
          onCanto={setCanto}
          onAlwaysOnTop={setAlwaysOnTop}
          onPular={aoPular}
          onMinimize={aoMinimizar}
          onClose={aoFechar}
        />
      </div>
    </div>
  );
}

export default App;
