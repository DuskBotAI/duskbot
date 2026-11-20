---
name: pdf-files
description: "Making a PDF with reportlab: register a TTF font first so symbols such as ₹, € and curly quotes render."
---

# PDF files

reportlab's built-in fonts (Helvetica, Times) have no ₹ and draw it as a black box. Before drawing text, register a TTF
font that has it and use it everywhere:

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import glob
path = next(iter(glob.glob("/usr/share/fonts/**/DejaVuSans.ttf", recursive=True) + glob.glob("/usr/share/fonts/**/FreeSans.ttf", recursive=True)), None)
if path:
    pdfmetrics.registerFont(TTFont("Body", path))
```

Then use `"Body"` as the font name (and in paragraph styles). Open the finished PDF's text (pdftotext) once to check the
symbols came through before you attach it.
