import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Загрузчик: принимает команды по D-Bus и подгружает логику режима из mode.js.
// GJS кеширует модули по пути, поэтому при изменении файлов они копируются
// в новый каталог и импортируются оттуда — перезаход в сессию не нужен.
// Сам этот файл меняется редко: его правка всё ещё требует перезахода.

const DBUS_PATH = '/org/gnome/Shell/Extensions/Dndmod';
const DBUS_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.Dndmod">
    <method name="Start"/>
    <method name="StartWithOptions">
      <arg type="as" direction="in" name="options"/>
    </method>
    <method name="Stop"/>
  </interface>
</node>`;

const COPIES_DIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'dndmod']);

export default class DndmodExtension extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, this);
        this._dbus.export(Gio.DBus.session, DBUS_PATH);
        this._load()
            .then(module => module.recoverAfterCrash())
            .catch(e => this._fail(e));
    }

    disable() {
        this._mode?.stop();
        this._mode = this._module = this._stamp = null;
        this._dbus.unexport();
        this._dbus = null;
    }

    /**
     * D-Bus: включает режим на свежей версии кода.
     *
     * @returns {void}
     */
    Start() {
        this._start([]).catch(e => this._fail(e));
    }

    /**
     * D-Bus: включает режим с параметрами, например ['code'].
     *
     * @param {string[]} options
     * @returns {void}
     */
    StartWithOptions(options) {
        this._start(options).catch(e => this._fail(e));
    }

    /**
     * D-Bus: выключает режим без пароля (аварийный выход из TTY).
     *
     * @returns {void}
     */
    Stop() {
        this._mode?.stop();
    }

    /**
     * @param {string[]} options
     * @returns {Promise<void>}
     */
    async _start(options) {
        if (this._mode?.active)
            return;
        const module = await this._load();
        if (!this._dbus || this._mode?.active)
            return;
        this._mode = new module.Mode();
        this._mode.start(options);
    }

    /**
     * Возвращает модуль mode.js; если файлы изменились — загружает заново.
     *
     * @returns {Promise<object>}
     */
    async _load() {
        const stamp = this._sourceStamp();
        if (this._module && stamp === this._stamp)
            return this._module;

        const dir = GLib.build_filenamev([COPIES_DIR, stamp]);
        GLib.mkdir_with_parents(dir, 0o700);
        for (const name of this._modules()) {
            this.dir.get_child(name).copy(
                Gio.File.new_for_path(GLib.build_filenamev([dir, name])),
                Gio.FileCopyFlags.OVERWRITE, null, null);
        }

        const module = await import(Gio.File.new_for_path(GLib.build_filenamev([dir, 'mode.js'])).get_uri());
        this._module = module;
        this._stamp = stamp;
        this._removeOldCopies(stamp);
        return module;
    }

    /**
     * Все модули расширения, кроме самого загрузчика, в стабильном порядке.
     *
     * @returns {string[]}
     */
    _modules() {
        const names = [];
        for (const info of this.dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)) {
            const name = info.get_name();
            if (name.endsWith('.js') && name !== 'extension.js')
                names.push(name);
        }
        return names.sort();
    }

    /**
     * Метка версии: время изменения всех модулей с точностью до микросекунд.
     *
     * @returns {string}
     */
    _sourceStamp() {
        return this._modules().map(name => {
            const info = this.dir.get_child(name).query_info(
                'time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null);
            return `${info.get_attribute_uint64('time::modified')}` +
                `${info.get_attribute_uint32('time::modified-usec')}`;
        }).join('-');
    }

    /**
     * Удаляет копии прошлых версий (уже загруженный модуль живёт в памяти).
     *
     * @param {string} keep метка текущей версии
     * @returns {void}
     */
    _removeOldCopies(keep) {
        const root = Gio.File.new_for_path(COPIES_DIR);
        for (const info of root.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)) {
            if (info.get_name() === keep)
                continue;
            const dir = root.get_child(info.get_name());
            for (const child of dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null))
                dir.get_child(child.get_name()).delete(null);
            dir.delete(null);
        }
    }

    /**
     * @param {Error} e
     * @returns {void}
     */
    _fail(e) {
        console.error(`dndmod: ${e.message}\n${e.stack}`);
        Main.notify('dndmod', `Ошибка: ${e.message}`);
    }
}
