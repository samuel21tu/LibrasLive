/**
 * Normalização e lematização de texto pt-BR para o pipeline LibrasLive.
 *
 * Caminho principal: determinístico, offline e sem dependências nativas.
 * Caminho opcional: `normalizarComSpaCy`, que usa spaCy pt_core_news_md via
 * subprocess Python e cai no caminho determinístico se o modelo não existir.
 *
 * Instalação do modelo (opcional):
 *   python -m pip install spacy
 *   python -m spacy download pt_core_news_md
 */

export type TokenNormalizado = {
  /** Palavra como apareceu no texto (após limpeza de pontuação). */
  original: string;
  /** Minúsculas, acentos preservados, abreviações expandidas, números por extenso. */
  texto: string;
  /** Lema em minúsculas, acentos preservados. */
  lemma: string;
  /** Posição do token no texto normalizado. */
  indice: number;
  /** Houve vírgula entre este token e o anterior (limite de oração). */
  pausaAntes: boolean;
};

export type TipoPergunta = "simnao" | "qu" | null;

export type TextoNormalizado = {
  textoOriginal: string;
  textoNormalizado: string;
  tokens: TokenNormalizado[];
  ehPergunta: boolean;
  tipoPergunta: TipoPergunta;
  temNegacao: boolean;
  /** Intensidade detectada por intensificadores e "!"; 0..1. */
  intensidade: number;
};

/** Remove acentos — usado para casar tokens com `palavras` do lexicon. */
export function removerAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const ABREVIACOES: Record<string, string> = {
  vcs: "vocês",
  vc: "você",
  obgd: "obrigado",
  obg: "obrigado",
  vlw: "valeu",
  blz: "beleza",
  tbm: "também",
  tm: "também",
  tb: "também",
  msm: "mesmo",
  cmg: "comigo",
  pras: "para as",
  pros: "para os",
  pro: "para o",
  pra: "para",
  qd: "quando",
  qto: "quanto",
  qt: "quanto",
  mto: "muito",
  mt: "muito",
  tds: "todos",
  td: "tudo",
  cmo: "como",
  pq: "por que",
  amanha: "amanhã",
  agr: "agora",
  eh: "é",
  n: "não",
  fone: "telefone",
  cel: "celular",
  pc: "computador",
};

const CHAVES_ABREVIACAO = Object.keys(ABREVIACOES).sort((a, b) => b.length - a.length);

export function expandirAbreviacoes(texto: string): string {
  let resultado = texto;
  for (const chave of CHAVES_ABREVIACAO) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    resultado = resultado.replace(re, ABREVIACOES[chave]);
  }
  return resultado;
}

const UNIDADES = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const DEZENAS = ["", "dez", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS = ["", "cem", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const IRREGULARES_10_A_19 = [
  "dez", "onze", "doze", "treze", "catorze", "quinze",
  "dezesseis", "dezessete", "dezoito", "dezenove",
];

function ateNovecentos(n: number): string {
  const partes: string[] = [];
  const centena = Math.floor(n / 100);
  const resto = n % 100;
  if (centena > 0) {
    partes.push(centena === 1 && resto > 0 ? "cento" : CENTENAS[centena]);
  }
  if (resto > 0) {
    if (resto < 10) {
      partes.push(UNIDADES[resto]);
    } else if (resto < 20) {
      partes.push(IRREGULARES_10_A_19[resto - 10]);
    } else {
      const dezena = Math.floor(resto / 10);
      const unidade = resto % 10;
      partes.push(unidade > 0 ? `${DEZENAS[dezena]} e ${UNIDADES[unidade]}` : DEZENAS[dezena]);
    }
  }
  return partes.join(" e ");
}

/** Converte um inteiro não negativo em português (até 999.999). */
export function numeroPorExtenso(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  n = Math.floor(n);
  if (n === 0) return "zero";
  if (n < 1000) return ateNovecentos(n);
  const milhares = Math.floor(n / 1000);
  const resto = n % 1000;
  const prefixo = milhares === 1 ? "mil" : `${ateNovecentos(milhares)} mil`;
  return resto > 0 ? `${prefixo} e ${ateNovecentos(resto)}` : prefixo;
}

export function numerosPorExtenso(texto: string): string {
  return texto.replace(/\d+(?:[.,]\d+)?/g, (match) => {
    const [inteiro, decimais] = match.split(/[.,]/);
    const partes = [numeroPorExtenso(Number(inteiro))];
    if (decimais !== undefined) {
      partes.push("vírgula");
      for (const digito of decimais) partes.push(UNIDADES[Number(digito)]);
    }
    return partes.join(" ");
  });
}

/**
 * Dicionário de formas irregulares e flexões comuns → lema usado no lexicon.
 * A cobertura é a necessária para o domínio do produto; formas regulares
 * caem nas regras sufixais abaixo.
 */
const LEMAS_IRREGULARES: Record<string, string> = {
  sou: "ser", és: "ser", é: "ser", somos: "ser", são: "ser", era: "ser", foi: "ser", será: "ser",
  estou: "estar", está: "estar", estamos: "estar", estão: "estar", estava: "estar", esteve: "estar",
  vou: "ir", vai: "ir", vamos: "ir", vão: "ir", fui: "ir",
  venho: "vir", vem: "vir", vimos: "vir", vêm: "vir", vim: "vir",
  faço: "fazer", faz: "fazer", fez: "fazer", fizeram: "fazer", farei: "fazer",
  como: "comer", come: "comer", comeu: "comer", comi: "comer",
  bebo: "beber", bebe: "beber", bebeu: "beber",
  durmo: "dormir", dorme: "dormir", dormiu: "dormir",
  vejo: "ver", vê: "ver", viu: "ver", vi: "ver",
  ouço: "ouvir", ouve: "ouvir", ouviu: "ouvir",
  quero: "querer", quer: "querer", quis: "querer", quiseram: "querer",
  tenho: "ter", tem: "ter", teve: "ter", tiveram: "ter",
  há: "haver", houve: "haver",
  dou: "dar", dá: "dar", deu: "dar", dei: "dar",
  trago: "trazer", traz: "trazer", trouxe: "trazer",
  sei: "saber", soube: "saber",
  entendo: "entender", entendeu: "entender",
  leio: "ler", lê: "ler", leu: "ler", li: "ler",
  escrevo: "escrever", escreveu: "escrever",
  sinto: "sentir", sente: "sentir", sentiu: "sentir",
  penso: "pensar", pensou: "pensar",
  peço: "pedir", pede: "pedir", pediu: "pedir",
  consigo: "conseguir", consegue: "conseguir", conseguiu: "conseguir",
  escolho: "escolher", escolhe: "escolher", escolheu: "escolher",
  agradeço: "agradecer", agradece: "agradecer", agradeceu: "agradecer",
  começo: "começar", começa: "começar", começou: "começar",
  dirijo: "dirigir", dirige: "dirigir", dirigiu: "dirigir",
  rio: "rir", ri: "rir", riu: "rir",
  sorrio: "sorrir", sorri: "sorrir", sorriu: "sorrir",
  cães: "cachorro", cão: "cachorro", cachorros: "cachorro", cachorra: "cachorro",
  homens: "homem", mulheres: "mulher", crianças: "criança", bebês: "bebê",
  pessoas: "pessoa", irmãos: "irmão", irmãs: "irmão", filhos: "filho", filhas: "filho",
  mãos: "mão", pés: "pé", olhos: "olho", dentes: "dente", corações: "coração",
  avós: "avó", pães: "pão", árvores: "árvore", flores: "flor",
  cidades: "cidade", horas: "hora", dias: "dia", noites: "noite",
  melhores: "melhor", piores: "pior", maiores: "maior", menores: "menor",
  rápidamente: "rapidamente", provávelmente: "provavelmente",
};

const REGRAS_LEMA: Array<[RegExp, string]> = [
  [/amentos$/, "amento"],
  [/imentos$/, "imento"],
  [/ando$/, "ar"],
  [/endo$/, "er"],
  [/indo$/, "ir"],
  [/amos$/, "ar"],
  [/emos$/, "er"],
  [/imos$/, "ir"],
  [/aram$/, "ar"],
  [/eram$/, "er"],
  [/iram$/, "ir"],
  [/aremos$/, "ar"],
  [/eremos$/, "er"],
  [/iremos$/, "ir"],
  [/ões$/, "ão"],
  [/ães$/, "ão"],
  [/ais$/, "al"],
  [/eis$/, "el"],
  [/ois$/, "ol"],
  [/uis$/, "ul"],
  [/ãs$/, "ã"],
  [/ês$/, "ê"],
  [/as$/, "a"],
  [/es$/, "e"],
  [/is$/, "i"],
  [/os$/, "o"],
  [/us$/, "u"],
];

/** Lematizador determinístico: dicionário irregular + regras sufixais. */
export function lematizar(palavra: string): string {
  const p = palavra.toLowerCase();
  if (LEMAS_IRREGULARES[p]) return LEMAS_IRREGULARES[p];
  if (p.length <= 3) return p;
  for (const [re, substituto] of REGRAS_LEMA) {
    if (re.test(p)) {
      const candidato = p.replace(re, substituto);
      if (candidato.length >= 3) return candidato;
    }
  }
  return p;
}

const QU_PATTERN = /\b(?:onde|quem|quando|como|qual|quais|quanto|quanta|quantos|quantas|por que|porque|que horas|de quem|para que|cujo|cuja)\b/iu;
const NEGACAO_PATTERN = /\b(?:n[ãa]o|nunca|jamais|nada|ningu[ée]m|nem|de jeito nenhum)\b/iu;
export const INTENSIFICADORES = [
  "muito", "mt", "mto", "bem", "super", "demais", "extremamente",
  "totalmente", "bastante", "tão", "tanto", "mega", "ultra", "intensamente",
];
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function detectarIntensidade(texto: string): number {
  let intensidade = 0;
  let quantos = 0;
  for (const intensificador of INTENSIFICADORES) {
    const re = new RegExp(`\\b${intensificador}\\b`, "giu");
    quantos += (texto.match(re) ?? []).length;
  }
  if (quantos > 0) intensidade += 0.5 + Math.min(0.25, (quantos - 1) * 0.12);
  const exclames = (texto.match(/!/g) ?? []).length;
  if (exclames > 0) intensidade += Math.min(0.3, exclames * 0.15);
  return Math.min(1, Number(intensidade.toFixed(3)));
}

/**
 * Normaliza o texto e produz tokens com lema + marcas de pergunta/negação/intensidade.
 * Totalmente determinístico e síncrono — é o caminho usado nos testes e em produção
 * quando spaCy não está disponível.
 */
export function normalizar(textoOriginal: string): TextoNormalizado {
  const semQuebras = String(textoOriginal ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const expandido = expandirAbreviacoes(semQuebras.toLocaleLowerCase("pt-BR"));
  const comNumeros = numerosPorExtenso(expandido);
  const textoNormalizado = comNumeros.replace(/[^\p{L}\p{N}\s'’-]/gu, " ").replace(/\s+/g, " ").trim();

  const tokens: TokenNormalizado[] = [];
  let fimAnterior = 0;
  for (const match of comNumeros.matchAll(TOKEN_PATTERN)) {
    const original = match[0];
    const inicio = match.index ?? tokens.length;
    tokens.push({
      original,
      texto: original,
      lemma: lematizar(original),
      indice: inicio,
      pausaAntes: /,|;|:|—/.test(comNumeros.slice(fimAnterior, inicio)),
    });
    fimAnterior = inicio + original.length;
  }

  const comInterrogacao = /[?]/.test(textoOriginal);
  const quNoInicio = /^(?:onde|quem|quando|como|qual|quais|quanto|quanta|quantos|quantas|por que|porque|de quem|para que|que horas)\b/iu
    .test(textoNormalizado.trim());
  const ehQu = QU_PATTERN.test(textoNormalizado) && (comInterrogacao || quNoInicio);
  const ehPergunta = comInterrogacao || ehQu;
  const tipoPergunta: TipoPergunta = ehQu ? "qu" : ehPergunta ? "simnao" : null;

  return {
    textoOriginal,
    textoNormalizado,
    tokens,
    ehPergunta,
    tipoPergunta,
    temNegacao: NEGACAO_PATTERN.test(textoNormalizado),
    intensidade: detectarIntensidade(textoOriginal + " " + comNumeros),
  };
}

export type OpcoesSpaCy = {
  /** Nome do modelo spaCy. Padrão: pt_core_news_md. */
  modelo?: string;
  /** Interpretador Python. Padrão: python3. */
  python?: string;
  /** Timeout do subprocess em ms. Padrão: 5000. */
  timeoutMs?: number;
};

/**
 * Variante assíncrona que tenta refinhar os lemas com spaCy pt_core_news_md.
 * Se o pacote/modelo não estiver instalado, devolve exatamente o resultado de
 * `normalizar` — o fallback determinístico nunca deixa o pipeline quebrar.
 *
 *   python -m pip install spacy
 *   python -m spacy download pt_core_news_md
 */
export async function normalizarComSpaCy(
  texto: string,
  opcoes: OpcoesSpaCy = {},
): Promise<TextoNormalizado> {
  const base = normalizar(texto);
  const modelo = opcoes.modelo ?? "pt_core_news_md";
  const python = opcoes.python ?? "python3";
  const timeout = opcoes.timeoutMs ?? 5000;
  const script = [
    "import json,sys",
    "import spacy",
    `nlp=spacy.load(${JSON.stringify(modelo)})`,
    "doc=nlp(sys.stdin.read())",
    "print(json.dumps([t.lemma_ for t in doc if not t.is_space and not t.is_punct],ensure_ascii=False))",
  ].join("\n");

  try {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync(python, ["-c", script], {
      input: texto,
      timeout,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lemas: unknown = JSON.parse(stdout);
    if (Array.isArray(lemas) && lemas.length > 0) {
      base.tokens = base.tokens.map((token, indice) => {
        const lemma = lemas[indice];
        return typeof lemma === "string" && lemma.length > 0
          ? { ...token, lemma: lemma.toLocaleLowerCase("pt-BR") }
          : token;
      });
    }
  } catch {
    // spaCy ausente: manter lemas determinísticos já calculados.
  }
  return base;
}
