# AutoEdit

Painel do Premiere Pro que edita sozinho vídeos de pessoa falando: corta silêncios, repetições e vícios, faz J-cut, nivela a voz e dá zoom nos cortes. A edição sai numa **sequência nova**; a original fica intacta. Antes de ir para a timeline, você revisa cada corte e desmarca o que quiser manter.

## Como funciona

```
Painel (Premiere, UXP) ──http──> Motor local (Node: ffmpeg + whisper.cpp)
        ^                               │ só palavras e tempos
        │ importa o XML                 v
        └──── sequência nova <──── Cérebro na nuvem (Claude)
```

1. O painel lê a trilha V1 da sequência ativa (clipes, arquivos, tempos).
2. O motor monta o áudio da timeline, mede o volume (EBU R128), acha as pausas e transcreve palavra por palavra.
3. O cérebro decide repetições, falsos inícios e vícios. Sem internet, o motor decide sozinho com regras (modo offline).
4. O motor escreve um XML (Final Cut 7) com os cortes, o J-cut, o ganho de voz e os zooms.
5. O painel mostra a revisão; ao confirmar, importa o XML como sequência nova e abre.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `core/` | Regras de corte, plano de edição e gerador de XML. Puro, com testes |
| `engine/` | Motor local em `http://127.0.0.1:47380` (ffmpeg, whisper.cpp) |
| `server/` | API na nuvem: licença e decisões com Claude |
| `panel/` | Painel UXP do Premiere 25.6+ (cards escuros, ilustrações em traço, ponto vermelho = ligado) |

## Rodar em desenvolvimento

```
npm install
npm test                 # testes do núcleo
npm run engine           # motor local
ANTHROPIC_API_KEY=... npm run server   # cérebro (opcional; sem ele o motor usa o modo offline)
```

O motor precisa de `ffmpeg`, `ffprobe` e `whisper-cli` (whisper.cpp) no PATH ou na pasta `engine/bin`, e do modelo em `engine/models/ggml-small.bin`. Dá para apontar outros caminhos com `AUTOEDIT_FFMPEG`, `AUTOEDIT_FFPROBE`, `AUTOEDIT_WHISPER` e `AUTOEDIT_WHISPER_MODEL`.

Para carregar o painel: abra o **UXP Developer Tool**, clique em *Add Plugin*, escolha `panel/manifest.json` e depois *Load*. Ele aparece em **Janela > Extensões (UXP) > AutoEdit**.

## API do motor

| Rota | O que faz |
| --- | --- |
| `GET /health` | Versão e se ffmpeg/whisper foram encontrados |
| `POST /jobs` | Começa uma edição: `{ sequence, options, brain?, words? }` |
| `GET /jobs/:id` | Etapa, progresso e, no fim, o plano e o caminho do XML |
| `POST /jobs/:id/rebuild` | Refaz o XML mantendo os trechos em `{ keep: [{start,end}] }` |
| `POST /jobs/:id/cancel` | Cancela |

## Limites desta versão

- Lê só a trilha V1 e o áudio dos próprios clipes. Trilhas de música e B-roll ficam fora da sequência nova.
- Os clipes precisam ter o mesmo fps da sequência.
- Cor, legendas animadas, efeitos sonoros e Modo Reels entram nas fases 2 e 3.
