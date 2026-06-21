# One Node · Z-Image

[![ComfyUI](https://img.shields.io/badge/ComfyUI-custom--node-%23f0ad4e)](https://github.com/comfyanonymous/ComfyUI)

> **Un nodo, tutto quello che serve per Z-Image Turbo.**  
> Nessun grafo di nodi, nessuno spaghetti — prompt, genera, fatto.

![screenshot](screenshot.png)

---

## Installazione

```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/Adeliox/ComfyUI-OneNode-Z-Image.git
```

Riavvia ComfyUI. Il nodo si trova nel menu con `click destro → Add Node → ZImageOneNode`.

## Modelli necessari

Scarica e metti in `ComfyUI/models/`:

| Modello | Cartella | Link |
|---|---|---|
| Z-Image Turbo UNET | `models/diffusion_models/` | [HuggingFace](https://huggingface.co/zerointensity/z-image-turbo) |
| Qwen 3.4B text encoder | `models/text_encoders/` | [HuggingFace](https://huggingface.co/zerointensity/z-image-turbo) |
| ae.safetensors (VAE) | `models/vae/` | [HuggingFace](https://huggingface.co/zerointensity/z-image-turbo) |

## Come si usa

- **ZIMG** — Text-to-Image. Scrivi un prompt, scegli la risoluzione, genera.
- **Z-I2I** — Image-to-Image. Carica un'immagine, regola la forza (denoise), genera.

---

**Autore originale**: [yanokusnir-ai](https://github.com/yanokusnir-ai) — creatore del nodo FLUX.2 [klein] da cui questo progetto è stato adattato.

**Adattamento Z-Image e semplificazione**: Adeliox
