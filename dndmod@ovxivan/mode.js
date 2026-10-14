import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {currentWallpaperUri, paletteFromImage, pickColor, tint} from './palette.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');

const CHKPWD = '/usr/sbin/unix_chkpwd';
const FONT = 'Noto Sans Mono CJK JP';
const FONT_SIZE = 18;
const FRAME_MS = 50;
const WALLPAPER_DIM = 0.55;
const INPUT_RESET_US = 2 * GLib.USEC_PER_SEC;
const IDLE_INHIBIT_FLAG = 8;
const LATIN_LAYOUT = 'us';
const CODE_FONT_SIZE = 15;
const CODE_FRAME_SHARE = 0.7;
const CODE_RAIN_INTENSITY = 0.35;
const CODE_POLL_SEC = 2;
const CODE_PAUSE_MS = 1500;
const CODE_REPLAY_MS = 20000;
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*|--|;)/;
const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'dndmod']);
const STATE_FILE = GLib.build_filenamev([GLib.get_user_state_dir(), 'dndmod', 'show-banners']);
const HINT = 'Выход — пароль.  Аварийно: Ctrl+Alt+F3 → войти → dndmod --stop → Ctrl+Alt+F2';
const GLYPHS = Array.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*+-=<>' +
    'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ');

/**
 * Случайный символ матрицы.
 *
 * @returns {string}
 */
function randomGlyph() {
    return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
}

/**
 * Анимация падающих символов в стиле cmatrix.
 */
class MatrixRain {
    /**
     * @param {St.DrawingArea} area холст на весь экран
     * @param {import('./palette.js').PaletteColor[]} palette цвета капель
     */
    constructor(area, palette) {
        this._area = area;
        this._palette = palette;
        this.intensity = 1;
        this._cols = [];
        this._grid = [];
        this._cellW = Math.ceil(FONT_SIZE * 0.6);
        this._cellH = FONT_SIZE + 2;
        this._rows = 0;
        area.connect('repaint', a => this._paint(a));
    }

    /**
     * Сдвигает капли на один кадр и перерисовывает холст.
     *
     * @returns {void}
     */
    tick() {
        const [w, h] = this._area.get_size();
        const cols = Math.ceil(w / this._cellW);
        this._rows = Math.ceil(h / this._cellH);
        while (this._cols.length < cols) {
            this._cols.push(this._newDrop(true));
            this._grid.push([]);
        }
        for (const [i, drop] of this._cols.entries()) {
            drop.y += drop.speed;
            if (drop.y - drop.len > this._rows)
                this._cols[i] = this._newDrop(false);
            const row = Math.floor(drop.y);
            this._grid[i][row] = randomGlyph();
            if (Math.random() < 0.05)
                this._grid[i][row - Math.floor(Math.random() * drop.len)] = randomGlyph();
        }
        this._area.queue_repaint();
    }

    /**
     * Новая капля над верхним краем экрана.
     *
     * @param {boolean} scatter разбросать по высоте при первом запуске
     * @returns {{y: number, speed: number, len: number, color: object, head: object}}
     */
    _newDrop(scatter) {
        const rows = Math.max(this._rows, 1);
        return {
            y: scatter ? Math.random() * rows * 2 - rows : -Math.random() * rows / 2,
            speed: 0.3 + Math.random() * 0.7,
            len: 6 + Math.floor(Math.random() * rows / 2),
            ...this._colors(),
        };
    }

    /**
     * Цвет капли из палитры и почти белая голова того же оттенка.
     *
     * @returns {{color: object, head: object}}
     */
    _colors() {
        const color = pickColor(this._palette);
        return {color, head: tint(color, 0.75)};
    }

    /**
     * Рисует кадр: голова капли светлая, хвост цвета палитры с затуханием.
     *
     * @param {St.DrawingArea} area
     * @returns {void}
     */
    _paint(area) {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        cr.setSourceRGBA(0, 0, 0, WALLPAPER_DIM);
        cr.paint();
        cr.selectFontFace(FONT, Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(FONT_SIZE);
        for (const [i, drop] of this._cols.entries()) {
            const head = Math.floor(drop.y);
            for (let k = 0; k < drop.len; k++) {
                const row = head - k;
                const ch = this._grid[i][row];
                if (row < 0 || row >= this._rows || !ch)
                    continue;
                const {r, g, b} = k === 0 ? drop.head : drop.color;
                cr.setSourceRGBA(r, g, b, (k === 0 ? 1 : 1 - k / drop.len) * this.intensity);
                cr.moveTo(i * this._cellW, (row + 1) * this._cellH);
                cr.showText(ch);
            }
        }
        cr.$dispose();
    }
}

/**
 * Окно с кодом из сессии Claude, который «набирается» посимвольно.
 * Свежий код (live) прерывает набор истории на конце строки.
 */
class CodeTyper {
    /**
     * @param {St.DrawingArea} area холст окна
     * @param {import('./palette.js').PaletteColor} color цвет текста
     * @param {string} title имя сессии в заголовке
     */
    constructor(area, color, title) {
        this._area = area;
        this._color = color;
        this._title = title;
        this._history = [];
        this._queue = [];
        this._current = null;
        this._file = '';
        this._lines = [''];
        this._pos = 0;
        this._pause = 0;
        this._idle = 0;
        this._frame = 0;
        this._interrupt = false;
        area.connect('repaint', a => this._paint(a));
    }

    /**
     * Добавляет фрагменты в очередь набора.
     *
     * @param {import('./claude.js').Snippet[]} snippets
     * @param {boolean} live свежий код: в начало очереди, прервать историю
     * @returns {void}
     */
    push(snippets, live) {
        if (!snippets.length)
            return;
        const marked = snippets.map(s => ({...s, live}));
        this._history.push(...snippets);
        if (live) {
            this._queue = this._queue.filter(s => s.live);
            this._queue.push(...marked);
            if (this._current && !this._current.live)
                this._interrupt = true;
        } else {
            this._queue.push(...marked);
        }
    }

    /**
     * Один кадр: печатает несколько символов или выдерживает паузу.
     *
     * @returns {void}
     */
    tick() {
        this._frame++;
        if (this._pause > 0)
            this._pause -= FRAME_MS;
        else if (this._current)
            this._type();
        else
            this._next();
        this._area.queue_repaint();
    }

    /**
     * Берёт следующий фрагмент; если очередь пуста дольше CODE_REPLAY_MS —
     * начинает историю заново.
     *
     * @returns {void}
     */
    _next() {
        if (!this._queue.length) {
            this._idle += FRAME_MS;
            if (this._idle < CODE_REPLAY_MS || !this._history.length)
                return;
            this._queue = this._history.map(s => ({...s, live: false}));
        }
        this._idle = 0;
        this._current = this._queue.shift();
        this._file = this._current.file;
        this._lines = [''];
        this._pos = 0;
    }

    /**
     * Печатает 1–4 символа; отступ новой строки — сразу, как автоотступ редактора.
     *
     * @returns {void}
     */
    _type() {
        const code = this._current.code;
        let count = 1 + Math.floor(Math.random() * 4);
        while (count-- > 0 && this._pos < code.length) {
            const ch = code[this._pos++];
            if (ch !== '\n') {
                this._lines[this._lines.length - 1] += ch;
                continue;
            }
            if (this._interrupt) {
                this._finish(600);
                return;
            }
            let indent = '';
            while (code[this._pos] === ' ')
                indent += code[this._pos++];
            this._lines.push(indent);
            if (Math.random() < 0.15) {
                this._pause = 150 + Math.random() * 450;
                break;
            }
        }
        if (this._pos >= code.length)
            this._finish(CODE_PAUSE_MS);
    }

    /**
     * Завершает фрагмент: текст остаётся на экране до начала следующего.
     *
     * @param {number} pauseMs
     * @returns {void}
     */
    _finish(pauseMs) {
        this._current = null;
        this._interrupt = false;
        this._pause = pauseMs;
    }

    /**
     * Рисует окно: заголовок с сессией и файлом, последние строки кода, курсор.
     *
     * @param {St.DrawingArea} area
     * @returns {void}
     */
    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const {r, g, b} = this._color;
        const pad = 18;
        const lineH = Math.ceil(CODE_FONT_SIZE * 1.4);

        cr.setSourceRGBA(0, 0, 0, 0.78);
        cr.paint();
        cr.setSourceRGBA(r, g, b, 0.5);
        cr.setLineWidth(1);
        cr.rectangle(0.5, 0.5, w - 1, h - 1);
        cr.stroke();

        cr.selectFontFace(FONT, Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
        cr.setFontSize(CODE_FONT_SIZE);
        let header = this._file ? `${this._title} · ${this._file}` : `${this._title} · ожидание кода…`;
        while (header.length > 1 && cr.textExtents(header).xAdvance > w - pad * 2)
            header = `…${header.slice(2)}`;
        cr.setSourceRGBA(r, g, b, 0.55);
        cr.moveTo(pad, pad + CODE_FONT_SIZE);
        cr.showText(header);
        const top = pad + lineH + 8;
        cr.rectangle(pad, top - 6, w - pad * 2, 1);
        cr.fill();

        const rows = Math.max(1, Math.floor((h - top - pad) / lineH));
        const first = Math.max(0, this._lines.length - rows);
        let y = top;
        for (const line of this._lines.slice(first)) {
            y += lineH;
            if (!line)
                continue;
            cr.setSourceRGBA(r, g, b, COMMENT_LINE.test(line) ? 0.55 : 0.95);
            cr.moveTo(pad, y - lineH * 0.25);
            cr.showText(line);
        }

        const typing = this._current && this._pause <= 0;
        if (typing || this._frame % 20 < 10) {
            const last = this._lines[this._lines.length - 1];
            const x = pad + (last ? cr.textExtents(last).xAdvance : 0);
            const cursor = tint(this._color, 0.6);
            cr.setSourceRGBA(cursor.r, cursor.g, cursor.b, 0.9);
            cr.rectangle(x + 1, y - lineH * 0.95, CODE_FONT_SIZE * 0.55, lineH * 0.85);
            cr.fill();
        }
        cr.$dispose();
    }
}

/**
 * id текущей раскладки GNOME, например 'us'.
 *
 * @returns {string|undefined}
 */
function currentSourceId() {
    return Keyboard.getInputSourceManager().currentSource?.id;
}

/**
 * Раскладка xkb по id среди текущих источников ввода GNOME.
 *
 * @param {string} id например 'us' или 'ru'
 * @returns {object|undefined}
 */
function findInputSource(id) {
    return Object.values(Keyboard.getInputSourceManager().inputSources)
        .find(source => source.type === 'xkb' && source.id === id);
}

/**
 * Значение настройки из ~/.config/dndmod/<name> (пишет команда dndmod).
 *
 * @param {string} name например 'hints' или 'debug'
 * @returns {string|null} содержимое файла или null, если настройки нет
 */
function readConfig(name) {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([CONFIG_DIR, name]));
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return null;
    }
}

/**
 * Удаляет файл состояния после штатного выхода.
 *
 * @returns {void}
 */
function clearState() {
    GLib.unlink(STATE_FILE);
}

/**
 * Если прошлый режим не завершился штатно (перезагрузка, падение Shell),
 * возвращает уведомления в исходное состояние.
 *
 * @returns {void}
 */
export function recoverAfterCrash() {
    if (!GLib.file_test(STATE_FILE, GLib.FileTest.EXISTS))
        return;
    try {
        const [, bytes] = GLib.file_get_contents(STATE_FILE);
        const banners = new TextDecoder().decode(bytes).trim() !== 'false';
        new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'})
            .set_boolean('show-banners', banners);
    } catch (e) {
        console.warn(`dndmod: recover failed: ${e.message}`);
    }
    clearState();
}

/**
 * Режим «Не беспокоить»: оверлей с матрицей, захват ввода, выход по паролю.
 * Загружается расширением заново при каждом изменении файлов.
 */
export class Mode {
    /**
     * Включён ли режим сейчас.
     *
     * @returns {boolean}
     */
    get active() {
        return !!this._overlay;
    }

    /**
     * Включает режим. Повторный вызов игнорируется.
     *
     * @param {string[]} [options] 'code' — показывать код из сессии Claude,
     *     'black' — чёрный экран без обоев и анимации
     * @returns {void}
     */
    start(options = []) {
        if (this._overlay)
            return;

        const black = options.includes('black');
        this._buildOverlay(black);
        this._grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.LOCK_SCREEN});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            this.stop();
            Main.notify('dndmod', 'Не удалось захватить клавиатуру');
            return;
        }

        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._prevBanners = this._notifications.get_boolean('show-banners');
        this._saveState(this._prevBanners);
        this._notifications.set_boolean('show-banners', false);
        this._inhibitIdle();
        this._forceLatinLayout();
        this._watchCapsLock();
        this._hidePointer();
        this._debugLog(`start options=${JSON.stringify(options)} source=${currentSourceId()}`);

        if (!black) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
                this._rain.tick();
                this._typer?.tick();
                return GLib.SOURCE_CONTINUE;
            });
        }

        if (options.includes('code'))
            this._startCode().catch(e => console.error(`dndmod: code: ${e.message}\n${e.stack}`));
    }

    /**
     * Выключает режим без пароля. Нужен как аварийный выход из TTY.
     *
     * @returns {void}
     */
    stop() {
        if (!this._overlay)
            return;

        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._codePoll)
            GLib.source_remove(this._codePoll);
        this._timer = this._codePoll = 0;
        this._typer = null;
        this._buffer = '';

        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;

        if (this._notifications) {
            this._notifications.set_boolean('show-banners', this._prevBanners ?? true);
            clearState();
        }
        this._notifications = null;
        this._uninhibitIdle();
        this._restoreLayout();

        this._restorePointer();
        if (this._capsSignal)
            this._keymap.disconnect(this._capsSignal);
        this._capsSignal = 0;
        this._keymap = null;

        this._overlay.destroy();
        this._overlay = this._rain = null;
    }

    /**
     * Чёрный слой поверх всего: обои, матрица и подсказка внизу основного монитора.
     * В чёрном режиме обоев и матрицы нет; подсказка и Caps Lock — как обычно,
     * по умолчанию не видны.
     *
     * @param {boolean} black только чёрный экран
     * @returns {void}
     */
    _buildOverlay(black) {
        this._buffer = '';
        this._checking = false;
        this._overlay = new St.Widget({
            reactive: true,
            can_focus: true,
            style: 'background-color: black;',
        });
        this._overlay.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        const wallpaper = black ? null : currentWallpaperUri();
        this._palette = paletteFromImage(wallpaper);
        if (!black) {
            if (wallpaper) {
                for (const monitor of Main.layoutManager.monitors)
                    this._overlay.add_child(this._buildWallpaper(monitor, wallpaper));
            }

            const area = new St.DrawingArea();
            area.add_constraint(new Clutter.BindConstraint({
                source: this._overlay,
                coordinate: Clutter.BindCoordinate.SIZE,
            }));
            this._overlay.add_child(area);
            this._rain = new MatrixRain(area, this._palette);
        }
        this._debug = readConfig('debug') === 'on';
        this._hint = this._buildHint(this._palette[0]);
        this._overlay.add_child(this._hint);

        this._overlay.connect('key-press-event', (_a, event) => this._onKey(event));

        Main.uiGroup.add_child(this._overlay);
        Main.uiGroup.set_child_above_sibling(this._overlay, null);
        this._overlay.grab_key_focus();
    }

    /**
     * Окно набора кода по центру основного монитора поверх приглушённой матрицы.
     * Сначала набирается история сессии, затем каждые CODE_POLL_SEC
     * подхватывается свежий код. Модуль claude.js грузится только здесь.
     *
     * @returns {Promise<void>}
     */
    async _startCode() {
        const claude = await import('./claude.js');
        if (!this._overlay)
            return;
        const session = claude.activeSession();
        if (!session) {
            console.log('dndmod: нет активной сессии Claude, показываю только матрицу');
            return;
        }

        const reader = new claude.TranscriptReader(session);
        const monitor = Main.layoutManager.primaryMonitor;
        const width = Math.round(monitor.width * CODE_FRAME_SHARE);
        const height = Math.round(monitor.height * CODE_FRAME_SHARE);
        const area = new St.DrawingArea({
            x: monitor.x + Math.round((monitor.width - width) / 2),
            y: monitor.y + Math.round((monitor.height - height) / 2),
            width,
            height,
        });
        this._overlay.insert_child_below(area, this._hint);

        this._typer = new CodeTyper(area, this._palette[0], session.name);
        this._typer.push(reader.readNew(), false);
        this._rain.intensity = CODE_RAIN_INTENSITY;

        this._codePoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CODE_POLL_SEC, () => {
            try {
                this._typer?.push(reader.readNew(), true);
            } catch (e) {
                console.warn(`dndmod: code poll: ${e.message}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    /**
     * Обои рабочего стола на один монитор: заполняют его с обрезкой краёв.
     *
     * @param {Meta.Rectangle} monitor геометрия монитора
     * @param {string} uri file:// адрес изображения
     * @returns {St.Widget}
     */
    _buildWallpaper(monitor, uri) {
        return new St.Widget({
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            style: `background-image: url("${uri}"); background-size: cover;` +
                'background-position: center;',
        });
    }

    /**
     * Неяркая подсказка про выход внизу основного монитора и над ней —
     * предупреждение о Caps Lock. Подсказка по умолчанию скрыта: включается
     * dndmod --hints on или F1 в режиме. Предупреждение показывается всегда:
     * оно нужно для ввода пароля.
     *
     * @param {import('./palette.js').PaletteColor} color основной цвет палитры
     * @returns {St.Widget}
     */
    _buildHint(color) {
        const rgb = [color.r, color.g, color.b].map(c => Math.round(c * 255)).join(', ');
        const monitor = Main.layoutManager.primaryMonitor;
        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        const column = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 6px; margin-bottom: 12px;',
        });
        const label = 'font-family: monospace; font-size: 10pt; padding: 4px 10px;' +
            'background-color: rgba(0, 0, 0, 0.8);';
        this._capsLabel = new St.Label({
            text: 'Caps Lock',
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            style: `${label} color: rgba(255, 200, 80, 0.85);`,
        });
        this._hintLabel = new St.Label({
            text: HINT,
            visible: readConfig('hints') === 'on',
            x_align: Clutter.ActorAlign.CENTER,
            style: `${label} color: rgba(${rgb}, 0.45);`,
        });
        column.add_child(this._capsLabel);
        column.add_child(this._hintLabel);
        box.add_child(column);
        return box;
    }

    /**
     * Невидимый ввод пароля: символы копятся в буфере и проверяются
     * после каждого нажатия. Backspace — удалить символ, Escape — очистить,
     * F1 — показать или спрятать подсказку.
     * Если с прошлого нажатия прошло больше INPUT_RESET_US, набранное
     * сбрасывается: время сравнивается напрямую, без таймера, который
     * в GLib срабатывает с опозданием до секунды.
     *
     * @param {Clutter.Event} event
     * @returns {boolean}
     */
    _onKey(event) {
        const now = GLib.get_monotonic_time();
        const reset = now - (this._lastKeyAt ?? 0) > INPUT_RESET_US;
        if (reset)
            this._buffer = '';
        this._lastKeyAt = now;
        if (this._debug) {
            const ch = event.get_key_unicode();
            this._debugLog(`key reset=${reset} printable=${!!ch && ch >= ' '} ` +
                `ascii=${!!ch && ch >= ' ' && ch <= '~'} caps=${this._keymap?.get_caps_lock_state()} ` +
                `source=${currentSourceId()} lenBefore=${this._buffer.length}`);
        }

        switch (event.get_key_symbol()) {
        case Clutter.KEY_F1:
            this._hintLabel.visible = !this._hintLabel.visible;
            return Clutter.EVENT_STOP;
        case Clutter.KEY_BackSpace:
            this._buffer = this._buffer.slice(0, -1);
            break;
        case Clutter.KEY_Escape:
            this._buffer = '';
            break;
        default: {
            const ch = event.get_key_unicode();
            if (!ch || ch < ' ' || ch === '\x7f')
                return Clutter.EVENT_STOP;
            this._buffer += ch;
        }
        }
        this._verify();
        return Clutter.EVENT_STOP;
    }

    /**
     * Проверяет текущий буфер и выключает режим, как только пароль совпал.
     * Проверки идут по одной: если буфер изменился во время проверки,
     * следующая запускается сразу после текущей.
     *
     * @returns {Promise<void>}
     */
    async _verify() {
        if (this._checking)
            return;
        this._checking = true;
        let checked;
        do {
            checked = this._buffer;
            if (!checked)
                break;
            const ok = await this._checkPassword(checked).catch(() => false);
            this._debugLog(`check ok=${ok} len=${checked.length}`);
            if (!this._overlay)
                break;
            if (ok) {
                this.stop();
                break;
            }
        } while (checked !== this._buffer);
        this._checking = false;
    }

    /**
     * Сверяет пароль текущего пользователя через PAM-помощник unix_chkpwd.
     *
     * @param {string} password
     * @returns {Promise<boolean>}
     */
    async _checkPassword(password) {
        const proc = Gio.Subprocess.new(
            [CHKPWD, GLib.get_user_name(), 'nonull'],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const input = new GLib.Bytes(new TextEncoder().encode(`${password}\0`));
        await proc.communicate_async(input, null);
        return proc.get_successful();
    }

    /**
     * Запоминает исходное значение show-banners на диске,
     * чтобы вернуть его, если сессия оборвётся во время режима.
     *
     * @param {boolean} banners
     * @returns {void}
     */
    _saveState(banners) {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o700);
            GLib.file_set_contents(STATE_FILE, String(banners));
        } catch (e) {
            console.warn(`dndmod: save state failed: ${e.message}`);
        }
    }

    /**
     * Прячет указатель мыши, как экран блокировки GNOME. Mutter снова
     * показывает указатель при движении мыши, поэтому он прячется повторно
     * на каждый visibility-changed, пока режим включён.
     *
     * @returns {void}
     */
    _hidePointer() {
        this._cursorTracker = Meta.CursorTracker.get_for_display(global.display);
        this._pointerWasVisible = this._cursorTracker.get_pointer_visible();
        this._pointerSignal = this._cursorTracker.connect('visibility-changed', tracker => {
            if (tracker.get_pointer_visible())
                tracker.set_pointer_visible(false);
        });
        this._cursorTracker.set_pointer_visible(false);
    }

    /**
     * Возвращает указателю прежнюю видимость.
     *
     * @returns {void}
     */
    _restorePointer() {
        if (!this._cursorTracker)
            return;
        this._cursorTracker.disconnect(this._pointerSignal);
        this._cursorTracker.set_pointer_visible(this._pointerWasVisible ?? true);
        this._cursorTracker = null;
        this._pointerSignal = 0;
    }

    /**
     * Показывает предупреждение, пока включён Caps Lock: пароль набирается
     * вслепую, и заглавные буквы вместо строчных иначе не заметить.
     *
     * @returns {void}
     */
    _watchCapsLock() {
        this._keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        const update = () => {
            this._capsLabel.visible = this._keymap.get_caps_lock_state();
        };
        this._capsSignal = this._keymap.connect('state-changed', update);
        update();
    }

    /**
     * Пишет в журнал, если включена диагностика (dndmod --debug on).
     * Набранные символы не пишутся — только их признаки.
     *
     * @param {string} message
     * @returns {void}
     */
    _debugLog(message) {
        if (this._debug)
            console.log(`dndmod-debug: ${message}`);
    }

    /**
     * Включает раскладку us на время режима: пароль набирается вслепую,
     * и при активной ru клавиши дали бы кириллицу.
     * Переключение неинтерактивное, порядок раскладок в настройках не меняется.
     *
     * GNOME сам возвращает первую раскладку из настроек, когда после входа
     * в сессию стартует IBus или меняется список раскладок, поэтому
     * us удерживается всё время, пока режим включён.
     *
     * @returns {void}
     */
    _forceLatinLayout() {
        const manager = Keyboard.getInputSourceManager();
        this._prevSourceId = manager.currentSource?.id ?? null;
        this._layoutSignal = manager.connect('current-source-changed', () => {
            if (this._layoutIdle)
                return;
            this._layoutIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._layoutIdle = 0;
                this._ensureLatinLayout();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._ensureLatinLayout();
    }

    /**
     * Включает us, если сейчас активна другая раскладка.
     *
     * @returns {void}
     */
    _ensureLatinLayout() {
        const manager = Keyboard.getInputSourceManager();
        if (manager.currentSource?.id !== LATIN_LAYOUT)
            findInputSource(LATIN_LAYOUT)?.activate(false);
    }

    /**
     * Перестаёт удерживать us и возвращает раскладку, бывшую до режима.
     * Источник ищется по id: GNOME мог пересоздать объекты раскладок.
     *
     * @returns {void}
     */
    _restoreLayout() {
        const manager = Keyboard.getInputSourceManager();
        if (this._layoutSignal)
            manager.disconnect(this._layoutSignal);
        if (this._layoutIdle)
            GLib.source_remove(this._layoutIdle);
        this._layoutSignal = this._layoutIdle = 0;

        if (this._prevSourceId && this._prevSourceId !== manager.currentSource?.id)
            findInputSource(this._prevSourceId)?.activate(false);
        this._prevSourceId = null;
    }

    /**
     * Запрещает гасить и блокировать экран по простою, пока режим включён.
     *
     * @returns {void}
     */
    _inhibitIdle() {
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            'Inhibit', new GLib.Variant('(susu)', ['dndmod', 0, 'dndmod', IDLE_INHIBIT_FLAG]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    [this._cookie] = conn.call_finish(res).deepUnpack();
                    if (!this._overlay)
                        this._uninhibitIdle();
                } catch (e) {
                    console.warn(`dndmod: idle inhibit failed: ${e.message}`);
                }
            });
    }

    /**
     * Снимает запрет простоя.
     *
     * @returns {void}
     */
    _uninhibitIdle() {
        if (!this._cookie)
            return;
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            'Uninhibit', new GLib.Variant('(u)', [this._cookie]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
        this._cookie = 0;
    }
}
