import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
                cr.setSourceRGBA(r, g, b, k === 0 ? 1 : 1 - k / drop.len);
                cr.moveTo(i * this._cellW, (row + 1) * this._cellH);
                cr.showText(ch);
            }
        }
        cr.$dispose();
    }
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
     * @returns {void}
     */
    start() {
        if (this._overlay)
            return;

        this._buildOverlay();
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

        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            this._rain.tick();
            return GLib.SOURCE_CONTINUE;
        });
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
        this._timer = 0;
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

        this._overlay.destroy();
        this._overlay = this._rain = null;
    }

    /**
     * Чёрный слой поверх всего: матрица и подсказка внизу основного монитора.
     *
     * @returns {void}
     */
    _buildOverlay() {
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

        const wallpaper = currentWallpaperUri();
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
        const palette = paletteFromImage(wallpaper);
        this._rain = new MatrixRain(area, palette);
        this._overlay.add_child(this._buildHint(palette[0]));

        this._overlay.connect('key-press-event', (_a, event) => this._onKey(event));

        Main.uiGroup.add_child(this._overlay);
        Main.uiGroup.set_child_above_sibling(this._overlay, null);
        this._overlay.grab_key_focus();
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
     * Неяркая подсказка про выход внизу основного монитора.
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
        box.add_child(new St.Label({
            text: HINT,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            style: `color: rgba(${rgb}, 0.45); background-color: rgba(0, 0, 0, 0.8);` +
                'font-family: monospace; font-size: 10pt; padding: 4px 10px; margin-bottom: 12px;',
        }));
        return box;
    }

    /**
     * Невидимый ввод пароля: символы копятся в буфере и проверяются
     * после каждого нажатия. Backspace — удалить символ, Escape — очистить.
     * Если с прошлого нажатия прошло больше INPUT_RESET_US, набранное
     * сбрасывается: время сравнивается напрямую, без таймера, который
     * в GLib срабатывает с опозданием до секунды.
     *
     * @param {Clutter.Event} event
     * @returns {boolean}
     */
    _onKey(event) {
        const now = GLib.get_monotonic_time();
        if (now - (this._lastKeyAt ?? 0) > INPUT_RESET_US)
            this._buffer = '';
        this._lastKeyAt = now;

        switch (event.get_key_symbol()) {
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
