#!/usr/bin/env python3
"""Build the macOS and Windows application icons from one foreground PNG."""

import os
import shutil
import subprocess
import tempfile


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SOURCE = os.path.join(ROOT, 'scripts', 'assets', 'workdaddy-icon-foreground.png')
MAC_OUT = os.path.join(ROOT, 'scripts', 'assets', 'WorkDaddy.icns')
WIN_OUT = os.path.join(ROOT, 'release', 'WorkDaddy.ico')
BACKGROUND = '#e1e1e1'
WINDOWS_CORNER_RADIUS_RATIO = 0.20
ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def run(*args):
    subprocess.run(args, check=True)


def require_tool(name):
    path = shutil.which(name)
    if not path:
        raise SystemExit(f'missing required tool: {name}')
    return path


def render_base(magick, output, rounded, with_background=True):
    canvas = f'xc:{BACKGROUND}' if with_background else 'xc:none'
    args = [
        magick,
        '-size', '1024x1024', canvas,
        SOURCE,
        '-compose', 'over', '-composite',
    ]
    if rounded:
        radius = round(1024 * WINDOWS_CORNER_RADIUS_RATIO)
        args += [
            '(', '-size', '1024x1024', 'xc:none', '-fill', 'white',
            '-draw', f'roundrectangle 0,0 1023,1023 {radius},{radius}', ')',
            '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
        ]
    # iconutil expects full RGBA PNGs; grayscale-alpha inputs can collapse to a
    # single low-resolution icns layer and make macOS show its generic wrapper.
    args += ['-alpha', 'on', '-colorspace', 'sRGB', '-type', 'TrueColorAlpha']
    args.append(output)
    run(*args)


def render_size(magick, source, size, output):
    run(
        magick,
        source,
        '-filter', 'Lanczos',
        '-resize', f'{size}x{size}',
        '-alpha', 'on', '-colorspace', 'sRGB', '-type', 'TrueColorAlpha',
        output,
    )


def build_mac_icon(magick, iconutil, temp_dir):
    base = os.path.join(temp_dir, 'mac-base.png')
    iconset = os.path.join(temp_dir, 'AppIcon.iconset')
    os.makedirs(iconset)
    # macOS supplies the standard rounded app background. Supplying another
    # background here creates a visible nested square in Finder/Get Info.
    render_base(magick, base, rounded=False, with_background=False)
    iconset_entries = [
        ('icon_16x16.png', 16),
        ('icon_16x16@2x.png', 32),
        ('icon_32x32.png', 32),
        ('icon_32x32@2x.png', 64),
        ('icon_128x128.png', 128),
        ('icon_128x128@2x.png', 256),
        ('icon_256x256.png', 256),
        ('icon_256x256@2x.png', 512),
        ('icon_512x512.png', 512),
        ('icon_512x512@2x.png', 1024),
    ]
    for name, size in iconset_entries:
        render_size(magick, base, size, os.path.join(iconset, name))
    os.makedirs(os.path.dirname(MAC_OUT), exist_ok=True)
    run(iconutil, '-c', 'icns', iconset, '-o', MAC_OUT)


def build_windows_icon(magick, temp_dir):
    base = os.path.join(temp_dir, 'windows-base.png')
    render_base(magick, base, rounded=True)
    pngs = []
    for size in ICON_SIZES:
        output = os.path.join(temp_dir, f'windows-{size}.png')
        render_size(magick, base, size, output)
        pngs.append(output)
    os.makedirs(os.path.dirname(WIN_OUT), exist_ok=True)
    run(magick, *pngs, '-colors', '256', WIN_OUT)


def main():
    if not os.path.isfile(SOURCE):
        raise SystemExit(f'missing icon foreground: {SOURCE}')
    magick = require_tool('magick')
    iconutil = require_tool('iconutil')
    with tempfile.TemporaryDirectory(prefix='workdaddy-icon-') as temp_dir:
        build_mac_icon(magick, iconutil, temp_dir)
        build_windows_icon(magick, temp_dir)
    print(f'macOS icon: {MAC_OUT}')
    print(f'Windows icon: {WIN_OUT}')


if __name__ == '__main__':
    main()
