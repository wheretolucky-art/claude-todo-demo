# claude-todo-demo

Small static pages, served by GitHub Pages straight from `main`.

| Page | Path |
| --- | --- |
| Humdard | `/humdard/` |
| A Little Place Called Us | `/us/` — opens only with its private link |

## A Little Place Called Us (`us/`)

A small interactive memory book in six chapters: a cover, a handful of
photographs, a scrapbook of memories, pages from a book, a letter in an
envelope, and a last page.

It is plain HTML, CSS and JavaScript modules. There is no framework and no
build step for the site itself, so GitHub Pages serves the folder as it is.

### What is, and is not, in this repository

This repository is public, so nothing personal is stored here in readable form.

- `us/index.html` and `us/assets/` hold only the empty cover, the styles and
  the code. They contain no names, no letters and no photographs.
- `us/pack/*.bin` holds every word and every photograph, encrypted with
  AES-128-GCM. Without the key these files are noise.
- The key is never committed. It exists only in the link that is shared, after
  the `#`. Browsers do not send that part of an address to any server, so
  neither GitHub nor a link preview ever sees it.
- `private/` (git-ignored) is where the readable originals live while editing.

Anyone who has the full link can open the book, so treat the link like the
gift itself. The page also asks search engines not to index it.

### Sharing it

Once this is on `main`, the address is

```
https://wheretolucky-art.github.io/claude-todo-demo/us/#<key>
```

Send the whole link, including everything after the `#`. Opened without the
key, the page shows only the cover and a box to paste the link into.

### Changing the words or the photographs

```sh
node tools/us/unpack.mjs <key>     # restores private/us/ from the sealed pack
# edit private/us/content.json, add or swap files in private/us/photos/
node tools/us/pack.mjs             # seals everything back into us/pack/
python3 -m http.server 8765        # then open http://localhost:8765/us/#<key>
```

Commit the changed files in `us/pack/`. The tools use only Node's standard
library. Photographs should already be web-sized (about 1400 px on the long
edge, WebP or JPEG); the tools encrypt them as they are.

`content.json` is the only place text lives. Each chapter has its own block:
`beginning`, `her` (photographs and captions), `memories` (the scrapbook
cards), `letters` (the pages of the book), `note` (the letter in the
envelope) and `last`.

### Hosting it somewhere else

The `us/` folder is self-contained and can be uploaded to any static host.
Two things to know: the page must be served over `https` (the browser's
decryption only works there), and the `og:image` address near the top of
`us/index.html` should be changed to the new location so the link preview
keeps its picture.

### Music

The music switch is off until someone turns it on, and nothing ever plays on
its own. By default it is a quiet music-box figure generated in the browser,
so no audio file is downloaded. To use a recording instead, put the file in
`us/` and set `TRACK` at the top of `us/assets/js/music.js`.

### Where things are

```
us/
  index.html            the cover, and the shell the chapters are poured into
  assets/css/main.css   all styles
  assets/js/app.js      start here: unseals the pack and wires the chapters up
  assets/js/vault.js    decryption
  assets/js/render.js   content → the six chapters
  assets/js/cover.js    opening sequence; opening and closing the book
  assets/js/gallery.js  the photograph viewer
  assets/js/deck.js     the scrapbook of memories
  assets/js/book.js     the letters: fits text to pages, turns them
  assets/js/envelope.js the envelope
  assets/js/music.js    the music switch
  assets/js/doodles.js  the small line drawings
  assets/fonts/         Cormorant Garamond, DM Sans, Reenie Beanie (SIL Open Font License)
  pack/                 the sealed content
tools/us/               pack.mjs and unpack.mjs
```
