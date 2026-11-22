/** Controles do painel overlay — spec seção 2 / 5. */

import type { PanelConfig } from "../types";
import type { QueueProgress } from "../avatar/AnimationQueue";
import type { StreamStatus } from "../useGlossStream";

export type ControlsProps = {
  tamanho: number;
  opacidade: number;
  canto: PanelConfig["canto"];
  alwaysOnTop: boolean;
  status: StreamStatus;
  progress: QueueProgress;
  texto: string;
  versaoLexicon: string | null;
  onTamanho: (valor: number) => void;
  onOpacidade: (valor: number) => void;
  onCanto: (canto: PanelConfig["canto"]) => void;
  onAlwaysOnTop: (valor: boolean) => void;
  onPular: () => void;
  onMinimize: () => void;
  onClose: () => void;
};

const CANTOS: { id: PanelConfig["canto"]; rotulo: string; simbolo: string }[] = [
  { id: "superior-esquerdo", rotulo: "Superior esquerdo", simbolo: "↖" },
  { id: "superior-direito", rotulo: "Superior direito", simbolo: "↗" },
  { id: "inferior-esquerdo", rotulo: "Inferior esquerdo", simbolo: "↙" },
  { id: "inferior-direito", rotulo: "Inferior direito", simbolo: "↘" },
];

const STATUS_TEXTO: Record<StreamStatus, string> = {
  connecting: "Conectando…",
  online: "Online",
  demo: "Demo",
};

export function Controls({
  tamanho,
  opacidade,
  canto,
  alwaysOnTop,
  status,
  progress,
  texto,
  versaoLexicon,
  onTamanho,
  onOpacidade,
  onCanto,
  onAlwaysOnTop,
  onPular,
  onMinimize,
  onClose,
}: ControlsProps) {
  const porcentagem = Math.round(progress.clipProgress * 100);
  const legenda = progress.gloss ?? (progress.isPlaying ? "Sinalizando" : "Aguardando fala…");

  return (
    <div className="ll-controles">
      <div className="ll-linha" title="Texto reconhecido e gloss do sinal atual">
        <div className="ll-gloss">
          <span className="ll-gloss-texto">{legenda}</span>
          {progress.restantes > 1 && <span className="ll-fila">+{progress.restantes - 1}</span>}
        </div>
        <button className="ll-btn ll-btn-pular" onClick={onPular} title="Pular sinal atual" type="button">
          ⏭
        </button>
      </div>

      {texto && <div className="ll-texto" title="Transcrição">{texto}</div>}

      <div className="ll-barra" aria-hidden="true">
        <div className="ll-barra-preenchimento" style={{ width: `${porcentagem}%` }} />
      </div>

      <div className="ll-ajustes">
        <label className="ll-ajuste">
          <span>Tamanho</span>
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={tamanho}
            onChange={(evento) => onTamanho(Number(evento.target.value))}
            aria-label="Tamanho do avatar"
          />
        </label>
        <label className="ll-ajuste">
          <span>Opacidade</span>
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.05}
            value={opacidade}
            onChange={(evento) => onOpacidade(Number(evento.target.value))}
            aria-label="Opacidade do painel"
          />
        </label>
      </div>

      <div className="ll-cantos" role="group" aria-label="Canto da tela">
        {CANTOS.map((opcao) => (
          <button
            key={opcao.id}
            type="button"
            className={`ll-btn ll-canto ${canto === opcao.id ? "ativo" : ""}`}
            title={opcao.rotulo}
            aria-label={opcao.rotulo}
            aria-pressed={canto === opcao.id}
            onClick={() => onCanto(opcao.id)}
          >
            {opcao.simbolo}
          </button>
        ))}
      </div>

      <div className="ll-pe">
        <span className={`ll-status ll-status-${status}`} title={versaoLexicon ? `Lexicon v${versaoLexicon}` : "Lexicon local"}>
          <i className="ll-ponto" /> {STATUS_TEXTO[status]}
        </span>
        <label className="ll-top" title="Sempre na frente de outras janelas">
          <input
            type="checkbox"
            checked={alwaysOnTop}
            onChange={(evento) => onAlwaysOnTop(evento.target.checked)}
          />
          Sempre em cima
        </label>
        <div className="ll-acoes">
          <button className="ll-btn" type="button" onClick={onMinimize} title="Minimizar" aria-label="Minimizar">
            ─
          </button>
          <button className="ll-btn" type="button" onClick={onClose} title="Fechar" aria-label="Fechar">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
