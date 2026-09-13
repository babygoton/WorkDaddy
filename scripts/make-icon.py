#!/usr/bin/env python3
"""Build both application icons from the website's rounded SVG logo."""

import os
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SOURCE = os.path.join(ROOT, 'scripts', 'assets', 'workdaddy-logo.svg')
PNG_OUT = os.path.join(ROOT, 'scripts', 'assets', 'workdaddy-icon-foreground.png')
MAC_OUT = os.path.join(ROOT, 'scripts', 'assets', 'WorkDaddy.icns')
WIN_OUT = os.path.join(ROOT, 'release', 'WorkDaddy.ico')
ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]


def run(*args):
    subprocess.run(args, check=True)


def require_tool(name):
    path = shutil.which(name)
    if not path:
        raise SystemExit(f'missing required tool: {name}')
    return path


def render_base(magick, rsvg, output):
    # The panel keeps the website SVG unchanged. Application icons need a larger,
    # optically centered robot so its dark surround does not read as extra padding.
    namespace = 'http://www.w3.org/2000/svg'
    tree = ET.parse(SOURCE)
    robot = tree.getroot().find('.//{' + namespace + '}g[@filter="url(#robot-shadow)"]')
    if robot is None:
        raise SystemExit('website logo is missing its robot artwork group')
    robot.set('transform', 'translate(512 512) scale(1.14) translate(-490 -545) ' + robot.get('transform', ''))
    ET.register_namespace('', namespace)
    app_source = os.path.join(os.path.dirname(output), 'application-logo.svg')
    tree.write(app_source, encoding='unicode')
    # librsvg preserves the website's gradients, shadows and rounded alpha mask.
    run(rsvg, '--width', '1024', '--height', '1024', '--output', output, app_source)
    run(magick, output, '-alpha', 'on', '-colorspace', 'sRGB', '-type', 'TrueColorAlpha', output)


def render_size(magick, source, size, output):
    run(
        magick,
        source,
        '-filter', 'Lanczos',
        '-resize', f'{size}x{size}',
        '-alpha', 'on', '-colorspace', 'sRGB', '-type', 'TrueColorAlpha',
        output,
    )


def build_mac_icon(magick, iconutil, temp_dir, base):
    iconset = os.path.join(temp_dir, 'AppIcon.iconset')
    os.makedirs(iconset)
    # The SVG already owns its silhouette; do not add another background or mask.
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


def build_windows_icon(magick, temp_dir, base):
    pngs = []
    for size in ICON_SIZES:
        output = os.path.join(temp_dir, f'windows-{size}.png')
        render_size(magick, base, size, output)
        pngs.append(output)
    os.makedirs(os.path.dirname(WIN_OUT), exist_ok=True)
    run(magick, *pngs, WIN_OUT)


def main():
    if not os.path.isfile(SOURCE):
        raise SystemExit(f'missing website logo: {SOURCE}')
    magick = require_tool('magick')
    iconutil = require_tool('iconutil')
    rsvg = require_tool('rsvg-convert')
    with tempfile.TemporaryDirectory(prefix='workdaddy-icon-') as temp_dir:
        base = os.path.join(temp_dir, 'website-logo.png')
        render_base(magick, rsvg, base)
        build_mac_icon(magick, iconutil, temp_dir, base)
        build_windows_icon(magick, temp_dir, base)
        shutil.copyfile(base, PNG_OUT)
    print(f'macOS icon: {MAC_OUT}')
    print(f'Windows icon: {WIN_OUT}')


if __name__ == '__main__':
    main()
