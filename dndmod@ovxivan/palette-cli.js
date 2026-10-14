// Вывод палитры dndmod в терминал: `dndmod --palette [FILE]`.
// Запускается через gjs вне GNOME Shell, поэтому импортирует только palette.js.

import Gio from 'gi://Gio';
import System from 'system';

import {DEFAULT_PALETTE, currentWallpaperUri, paletteFromImage, tint} from './palette.js';

const SAMPLE = 'ｱｲｳｴｵｶｷｸｹｺ0123456789';
const RESET = '\x1b[0m';

/**
 * ANSI-последовательность truecolor для цвета текста.
 *
 * @param {{r: number, g: number, b: number}} c
 * @param {number} [alpha] 0..1 — затемнение, как у хвоста капли
 * @returns {string}
 */
function fg(c, alpha = 1) {
    const [r, g, b] = [c.r, c.g, c.b].map(v => Math.round(v * alpha * 255));
    return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * @param {{r: number, g: number, b: number}} c
 * @returns {string}
 */
function hex(c) {
    return '#' + [c.r, c.g, c.b]
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * Образец капли: светлая голова и затухающий хвост.
 *
 * @param {{r: number, g: number, b: number}} c
 * @returns {string}
 */
function drop(c) {
    const chars = [...SAMPLE];
    const tail = chars.slice(0, -1)
        .map((ch, i) => fg(c, 0.25 + 0.75 * (i + 1) / chars.length) + ch).join('');
    return `${tail}${fg(tint(c, 0.75))}${chars.at(-1)}${RESET}`;
}

const [arg] = System.programArgs;
const uri = arg ? Gio.File.new_for_commandline_arg(arg).get_uri() : currentWallpaperUri();
if (!uri) {
    print('Фон не задан: обои рабочего стола — слайдшоу или файл не найден.');
    print(`Палитра по умолчанию: ${drop(DEFAULT_PALETTE[0])}`);
    System.exit(0);
}

const palette = paletteFromImage(uri);
const total = palette.reduce((sum, c) => sum + c.weight, 0);

print(`Картинка: ${Gio.File.new_for_uri(uri).get_path()}`);
if (palette === DEFAULT_PALETTE)
    print('Насыщенных оттенков нет (или файл не читается) — зелёный по умолчанию.');
print('');
for (const c of palette) {
    const share = `${Math.round(c.weight / total * 100)}%`.padStart(4);
    print(`  ${fg(c)}████████${RESET}  ${hex(c)}  ${share}   ${drop(c)}`);
}
