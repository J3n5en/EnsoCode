"""将上游符号字体调整为终端单列宽度，保持图标比例与居中。

Fit the upstream symbol font to a single terminal column while keeping icons proportional and centered.
"""

import argparse

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


def prepare(source, destination):
    font = TTFont(source, recalcTimestamp=False)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    dividers = {name for code, name in cmap.items() if 0xE0B0 <= code <= 0xE0D7}
    advance = int(font['head'].unitsPerEm * 0.55)
    glyphs = {}
    metrics = {}
    for name in font.getGlyphOrder():
        old_advance, _ = font['hmtx'][name]
        glyph = font['glyf'][name]
        scale_x = advance / old_advance if old_advance else 1
        scale_y = 1
        offset_x = 0
        offset_y = 0
        if hasattr(glyph, 'xMax') and glyph.xMax > glyph.xMin:
            scale_x = min(1, advance / (glyph.xMax - glyph.xMin))
            scale_y = scale_x
            offset_x = (advance - (glyph.xMin + glyph.xMax) * scale_x) / 2
            offset_y = (glyph.yMin + glyph.yMax) * (1 - scale_y) / 2
        if name in dividers and hasattr(glyph, 'xMax') and glyph.xMax > glyph.xMin:
            # 分隔符横跨整格并略微越界，避免相邻色块之间出现细缝。
            #
            # Span the whole column with a small overscan to avoid seams between color blocks.
            scale_x = (advance + 2) / (glyph.xMax - glyph.xMin)
            scale_y = 1
            offset_x = -1 - glyph.xMin * scale_x
            offset_y = 0
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        pen = TTGlyphPen(None)
        recording.replay(TransformPen(pen, (scale_x, 0, 0, scale_y, offset_x, offset_y)))
        result = pen.glyph()
        result.recalcBounds(font['glyf'])
        glyphs[name] = result
        metrics[name] = (advance if old_advance else 0, getattr(result, 'xMin', 0))
    font['glyf'].glyphs = glyphs
    font['hmtx'].metrics = metrics
    for record in font['name'].names:
        value = {
            1: 'Enso Nerd Symbols Mono',
            2: 'Regular',
            3: 'Enso Nerd Symbols Mono Regular 3.4.0',
            4: 'Enso Nerd Symbols Mono Regular',
            6: 'EnsoNerdSymbolsMono-Regular',
        }.get(record.nameID)
        if value:
            record.string = value.encode(record.getEncoding())
    font.save(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('destination')
    args = parser.parse_args()
    prepare(args.source, args.destination)
