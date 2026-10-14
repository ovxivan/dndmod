import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Код, который пишет Claude Code в активной сессии.
// Источники — внутренние файлы Claude Code (формат не документирован):
//   ~/.claude/sessions/<pid>.json             — запущенные сессии: sessionId, cwd, name
//   ~/.claude/projects/<cwd>/<sessionId>.jsonl — история: вызовы Write/Edit с кодом

const CLAUDE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
const SESSIONS_DIR = GLib.build_filenamev([CLAUDE_DIR, 'sessions']);
const PROJECTS_DIR = GLib.build_filenamev([CLAUDE_DIR, 'projects']);
const MAX_LINES = 200;
const READ_CHUNK = 1 << 20;

// Файлы, которые не показываем вовсе, и строки, где маскируем значение.
const SECRET_FILE = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12)|id_(rsa|ed25519)[^/]*|credentials[^/]*)$/i;
const SECRET_VALUE = /((?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key)\w*["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}/gi;

/**
 * Фрагмент кода для набора.
 *
 * @typedef {{file: string, code: string, live?: boolean}} Snippet
 */

/**
 * Активная сессия Claude Code.
 *
 * @typedef {{sessionId: string, cwd: string, name: string, transcript: string}} Session
 */

/**
 * Самая свежая из запущенных сессий Claude Code, у которой есть история.
 *
 * @returns {Session|null}
 */
export function activeSession() {
    const sessions = [];
    for (const name of listDir(SESSIONS_DIR)) {
        if (!name.endsWith('.json'))
            continue;
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([SESSIONS_DIR, name]));
            const s = JSON.parse(new TextDecoder().decode(bytes));
            if (s.pid && s.sessionId && GLib.file_test(`/proc/${s.pid}`, GLib.FileTest.EXISTS))
                sessions.push(s);
        } catch {
            // файл пишется в этот момент или устарел — пропускаем
        }
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    for (const s of sessions) {
        const transcript = findTranscript(s.sessionId, s.cwd ?? '');
        if (transcript)
            return {sessionId: s.sessionId, cwd: s.cwd ?? '', name: s.name ?? s.sessionId.slice(0, 8), transcript};
    }
    return null;
}

/**
 * Читает историю сессии частями: при каждом вызове — только новые записи.
 */
export class TranscriptReader {
    /**
     * @param {Session} session
     */
    constructor(session) {
        this._file = Gio.File.new_for_path(session.transcript);
        this._cwd = session.cwd;
        this._offset = 0;
        this._tail = new Uint8Array(0);
    }

    /**
     * Новые фрагменты кода с прошлого вызова (при первом — вся история).
     *
     * @returns {Snippet[]}
     */
    readNew() {
        const size = this._file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        if (size < this._offset) {
            this._offset = 0;
            this._tail = new Uint8Array(0);
        }
        if (size === this._offset)
            return [];

        const fresh = this._readFrom(this._offset, size - this._offset);
        this._offset += fresh.length;

        // Декодируем только до последнего \n: недописанная строка (и, возможно,
        // разрезанный символ UTF-8) ждёт следующего чтения.
        const bytes = concat([this._tail, fresh]);
        const end = bytes.lastIndexOf(0x0a) + 1;
        this._tail = bytes.slice(end);
        return new TextDecoder().decode(bytes.subarray(0, end))
            .split('\n')
            .flatMap(line => this._parse(line));
    }

    /**
     * @param {number} offset
     * @param {number} length
     * @returns {Uint8Array}
     */
    _readFrom(offset, length) {
        const stream = this._file.read(null);
        try {
            stream.seek(offset, GLib.SeekType.SET, null);
            const chunks = [];
            let total = 0;
            while (total < length) {
                const chunk = stream.read_bytes(Math.min(READ_CHUNK, length - total), null).toArray();
                if (chunk.length === 0)
                    break;
                chunks.push(chunk);
                total += chunk.length;
            }
            return concat(chunks);
        } finally {
            stream.close(null);
        }
    }

    /**
     * Фрагменты кода из одной записи истории: Write, Edit, MultiEdit.
     *
     * @param {string} line строка JSONL
     * @returns {Snippet[]}
     */
    _parse(line) {
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            return [];
        }
        const content = entry?.type === 'assistant' ? entry.message?.content : null;
        if (!Array.isArray(content))
            return [];

        const snippets = [];
        for (const part of content) {
            if (part?.type !== 'tool_use' || !part.input)
                continue;
            const {file_path: file, content: written, new_string: edited, edits} = part.input;
            if (part.name === 'Write')
                snippets.push(this._snippet(file, written));
            else if (part.name === 'Edit')
                snippets.push(this._snippet(file, edited));
            else if (part.name === 'MultiEdit' && Array.isArray(edits))
                snippets.push(...edits.map(e => this._snippet(file, e?.new_string)));
        }
        return snippets.filter(Boolean);
    }

    /**
     * Готовит фрагмент к показу: путь относительно проекта, табы в пробелы,
     * маскировка секретов, не больше MAX_LINES строк. Файлы с секретами пропускаются.
     *
     * @param {string} file
     * @param {string} code
     * @returns {Snippet|null}
     */
    _snippet(file, code) {
        if (typeof file !== 'string' || typeof code !== 'string' || !code.trim() || SECRET_FILE.test(file))
            return null;
        let lines = code.replace(/\t/g, '    ').replace(SECRET_VALUE, '$1$2••••••').split('\n');
        if (lines.length > MAX_LINES)
            lines = [...lines.slice(0, MAX_LINES), '…'];
        return {file: this._shortPath(file), code: lines.join('\n')};
    }

    /**
     * Путь относительно проекта сессии, вне проекта — от домашней папки (~).
     *
     * @param {string} file
     * @returns {string}
     */
    _shortPath(file) {
        if (this._cwd && file.startsWith(`${this._cwd}/`))
            return file.slice(this._cwd.length + 1);
        const home = GLib.get_home_dir();
        return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
    }
}

/**
 * Склеивает массивы байтов.
 *
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

/**
 * Файл истории сессии: сначала по пути из cwd, затем поиском по всем проектам.
 *
 * @param {string} sessionId
 * @param {string} cwd
 * @returns {string|null}
 */
function findTranscript(sessionId, cwd) {
    const name = `${sessionId}.jsonl`;
    const direct = GLib.build_filenamev([PROJECTS_DIR, cwd.replace(/[^A-Za-z0-9]/g, '-'), name]);
    if (GLib.file_test(direct, GLib.FileTest.EXISTS))
        return direct;
    for (const dir of listDir(PROJECTS_DIR)) {
        const path = GLib.build_filenamev([PROJECTS_DIR, dir, name]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

/**
 * Имена файлов в каталоге; пустой список, если каталога нет.
 *
 * @param {string} path
 * @returns {string[]}
 */
function listDir(path) {
    try {
        const names = [];
        const iter = Gio.File.new_for_path(path)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (const info of iter)
            names.push(info.get_name());
        return names;
    } catch {
        return [];
    }
}
