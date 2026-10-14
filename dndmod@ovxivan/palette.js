import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Цвет палитры: компоненты 0..1 и вес — доля оттенка на картинке.
 *
 * @typedef {{r: number, g: number, b: number, weight: number}} PaletteColor
 */

/** @type {PaletteColor[]} классический зелёный cmatrix */
export const DEFAULT_PALETTE = [{r: 0, g: 0.9, b: 0.25, weight: 1}];

const WALLPAPER_CONF = GLib.build_filenamev([GLib.get_user_config_dir(), 'dndmod', 'wallpaper']);
const SAMPLE_SIZE = 64;
const HUE_BUCKETS = 36;
const MAX_COLORS = 4;
const MIN_PEAK_SHARE = 0.15;
const MIN_HUE_GAP = 3;
const MIN_SATURATION = 0.2;
const MIN_VALUE = 0.2;
const MIN_LUMINANCE = 0.3;

/** @type {Map<string, PaletteColor[]>} */
const cache = new Map();

/**
 * Фон режима: картинка из `dndmod --wallpaper`, иначе обои рабочего стола.
 *
 * @returns {string|null}
 */
export function currentWallpaperUri() {
    return customWallpaperUri() ?? desktopWallpaperUri();
}

/**
 * Картинка, сохранённая командой `dndmod --wallpaper FILE`.
 *
 * @returns {string|null}
 */
function customWallpaperUri() {
    try {
        const [, bytes] = GLib.file_get_contents(WALLPAPER_CONF);
        const file = Gio.File.new_for_path(new TextDecoder().decode(bytes).trim());
        return file.query_exists(null) ? file.get_uri() : null;
    } catch {
        return null;
    }
}

/**
 * Текущие обои GNOME с учётом тёмной темы. Слайдшоу (.xml) и
 * отсутствующие файлы не поддерживаются — тогда фон остаётся чёрным.
 *
 * @returns {string|null}
 */
function desktopWallpaperUri() {
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const dark = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
        .get_string('color-scheme') === 'prefer-dark';
    const uri = (dark && background.get_string('picture-uri-dark')) ||
        background.get_string('picture-uri');
    if (!uri || uri.endsWith('.xml'))
        return null;
    const file = Gio.File.new_for_uri(uri);
    return file.is_native() && file.query_exists(null) ? file.get_uri() : null;
}

/**
 * Палитра из преобладающих оттенков изображения.
 * Результат кешируется по адресу и времени изменения файла.
 *
 * @param {string|null} uri file:// адрес изображения
 * @returns {PaletteColor[]}
 */
export function paletteFromImage(uri) {
    if (!uri)
        return DEFAULT_PALETTE;

    const file = Gio.File.new_for_uri(uri);
    let key;
    try {
        const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        key = `${uri}@${info.get_modification_date_time().to_unix()}`;
    } catch {
        return DEFAULT_PALETTE;
    }

    if (!cache.has(key)) {
        cache.clear();
        cache.set(key, extractPalette(file.get_path()));
    }
    return cache.get(key);
}

/**
 * Случайный цвет палитры с учётом весов.
 *
 * @param {PaletteColor[]} palette
 * @returns {PaletteColor}
 */
export function pickColor(palette) {
    const total = palette.reduce((sum, c) => sum + c.weight, 0);
    let rest = Math.random() * total;
    for (const color of palette) {
        rest -= color.weight;
        if (rest <= 0)
            return color;
    }
    return palette[0];
}

/**
 * Смешивает цвет с белым.
 *
 * @param {PaletteColor} color
 * @param {number} amount 0 — исходный цвет, 1 — белый
 * @returns {PaletteColor}
 */
export function tint(color, amount) {
    return {
        r: color.r + (1 - color.r) * amount,
        g: color.g + (1 - color.g) * amount,
        b: color.b + (1 - color.b) * amount,
        weight: color.weight,
    };
}

/**
 * Гистограмма оттенков уменьшенной копии картинки: насыщенные и светлые
 * пиксели весят больше, серые и тёмные не учитываются. Из гистограммы
 * берутся пики, разнесённые по кругу оттенков не меньше чем на 30°.
 *
 * @param {string} path
 * @returns {PaletteColor[]}
 */
function extractPalette(path) {
    let pixbuf;
    try {
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, SAMPLE_SIZE, SAMPLE_SIZE, true);
    } catch (e) {
        console.warn(`dndmod: palette: ${e.message}`);
        return DEFAULT_PALETTE;
    }

    const pixels = pixbuf.read_pixel_bytes().toArray();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const weight = new Array(HUE_BUCKETS).fill(0);
    const satSum = new Array(HUE_BUCKETS).fill(0);

    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * channels;
            const [h, s, v] = rgbToHsv(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
            if (s < MIN_SATURATION || v < MIN_VALUE)
                continue;
            const bucket = Math.floor(h * HUE_BUCKETS) % HUE_BUCKETS;
            weight[bucket] += s * v;
            satSum[bucket] += s * s * v;
        }
    }

    const smooth = weight.map((w, i) =>
        w + weight[(i + 1) % HUE_BUCKETS] + weight[(i + HUE_BUCKETS - 1) % HUE_BUCKETS]);
    const order = [...smooth.keys()].sort((a, b) => smooth[b] - smooth[a]);
    if (smooth[order[0]] === 0)
        return DEFAULT_PALETTE;

    const peaks = [];
    for (const i of order) {
        if (peaks.length >= MAX_COLORS || smooth[i] < smooth[order[0]] * MIN_PEAK_SHARE)
            break;
        if (peaks.some(p => hueGap(p, i) < MIN_HUE_GAP))
            continue;
        peaks.push(i);
    }

    return peaks.map(i => {
        const sat = weight[i] > 0 ? satSum[i] / weight[i] : 0.8;
        const [r, g, b] = hsvToRgb((i + 0.5) / HUE_BUCKETS, clamp(sat, 0.55, 0.9), 1);
        return readable({r, g, b, weight: smooth[i]});
    });
}

/**
 * Высветляет цвет, пока он не станет заметен на затемнённом фоне
 * (тёмно-синий и фиолетовый иначе почти не видны).
 *
 * @param {PaletteColor} color
 * @returns {PaletteColor}
 */
function readable(color) {
    let c = color;
    for (let i = 0; i < 10 && luminance(c) < MIN_LUMINANCE; i++)
        c = tint(c, 0.1);
    return c;
}

/**
 * Относительная яркость по WCAG (без гамма-коррекции, для оценки).
 *
 * @param {PaletteColor} c
 * @returns {number}
 */
function luminance(c) {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Расстояние между корзинами по кругу оттенков.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function hueGap(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, HUE_BUCKETS - d);
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

/**
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @returns {number[]} [h, s, v], все 0..1
 */
function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d > 0) {
        if (max === r)
            h = ((g - b) / d + 6) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
    }
    return [h / 6, max ? d / max : 0, max];
}

/**
 * @param {number} h 0..1
 * @param {number} s 0..1
 * @param {number} v 0..1
 * @returns {number[]} [r, g, b], все 0..1
 */
function hsvToRgb(h, s, v) {
    const f = n => {
        const k = (n + h * 6) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
}
