// Модель «живого» набора кода: когда нажимать следующую клавишу,
// где задуматься и где опечататься. Без зависимостей от GNOME Shell —
// проверяется отдельно через gjs.

const KEY_MIN_MS = 45;
const KEY_SPREAD_MS = 90;
const FAMILIAR_WORD_CHANCE = 0.3;
const FAMILIAR_WORD_FACTOR = 0.6;
const TYPO_CHANCE = 0.02;
const LINE_THINK_CHANCE = 0.12;
const COMMENT_THINK_CHANCE = 0.4;
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ');
const COMMENT_START = /^\s*(\/\/|#|\*|\/\*|--|;)/;

// Соседние клавиши QWERTY: опечатка — это промах по соседней клавише.
const NEIGHBORS = {
    q: 'wa', w: 'qes', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'o[',
    a: 'qsz', s: 'awdz', d: 'sefx', f: 'drgc', g: 'fthv', h: 'gyjb', j: 'hukn', k: 'jilm', l: 'ko;',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
};

/**
 * Шаг набора: подождать delay мс и выполнить действие.
 *   char    — напечатать ch
 *   back    — стереть последний символ строки
 *   newline — перевести строку и сразу выставить отступ indent
 *   pause   — ничего не делать (задумался)
 *
 * @typedef {{op: 'char'|'back'|'newline'|'pause', delay: number, ch?: string, indent?: string}} TypingStep
 */

/**
 * Шаги набора кода так, как его набирал бы человек.
 * Применение всех шагов по порядку даёт ровно исходный текст.
 *
 * @param {string} code
 * @param {() => number} [random] источник случайности (для тестов)
 * @yields {TypingStep}
 * @returns {Generator<TypingStep>}
 */
export function* typingSteps(code, random = Math.random) {
    const between = (min, max) => min + random() * (max - min);
    let pos = 0;
    let prev = '\n';
    let familiar = false;

    // Интервал до нажатия ch: короткие чаще длинных, плюс ритм слов и Shift.
    const keyDelay = ch => {
        let delay = KEY_MIN_MS + KEY_SPREAD_MS * random() ** 1.6;
        if (isWordChar(ch) && !isWordChar(prev))
            familiar = random() < FAMILIAR_WORD_CHANCE;
        if (familiar && isWordChar(ch))
            delay *= FAMILIAR_WORD_FACTOR;
        if (prev === ' ')
            delay += between(40, 140);
        else if (',;:'.includes(prev))
            delay += between(100, 250);
        else if ('{(['.includes(prev))
            delay += between(60, 160);
        if (SHIFTED.has(ch))
            delay += between(30, 80);
        return delay;
    };

    while (pos < code.length) {
        const ch = code[pos];

        if (ch === '\n') {
            let indent = '';
            pos++;
            while (code[pos] === ' ')
                indent += code[pos++];
            yield {op: 'newline', indent, delay: between(120, 400)};
            prev = '\n';

            const end = code.indexOf('\n', pos);
            const line = code.slice(pos, end < 0 ? code.length : end);
            const think = COMMENT_START.test(line) ? COMMENT_THINK_CHANCE : LINE_THINK_CHANCE;
            if (line.trim() && random() < think)
                yield {op: 'pause', delay: between(500, 1800)};
            continue;
        }

        if (isLetter(ch) && random() < TYPO_CHANCE) {
            yield* typo(code, pos, keyDelay, between, random);
            prev = ch;
            pos++;
            continue;
        }

        yield {op: 'char', ch, delay: keyDelay(ch)};
        prev = ch;
        pos++;
    }
}

/**
 * Опечатка: промах по соседней клавише, иногда замеченный через 1–2 символа,
 * пауза, стирание и правильный набор. Переводы строк не затрагиваются.
 *
 * @param {string} code
 * @param {number} pos позиция правильного символа
 * @param {(ch: string) => number} keyDelay
 * @param {(min: number, max: number) => number} between
 * @param {() => number} random
 * @yields {TypingStep}
 * @returns {Generator<TypingStep>}
 */
function* typo(code, pos, keyDelay, between, random) {
    const ch = code[pos];
    const near = NEIGHBORS[ch.toLowerCase()];
    const wrong = near[Math.floor(random() * near.length)];
    yield {op: 'char', ch: ch === ch.toUpperCase() ? wrong.toUpperCase() : wrong, delay: keyDelay(ch)};

    // Сколько символов успели набрать, прежде чем заметить ошибку.
    const r = random();
    let extra = r < 0.6 ? 0 : r < 0.9 ? 1 : 2;
    let typed = 0;
    while (typed < extra && pos + 1 + typed < code.length && code[pos + 1 + typed] !== '\n') {
        yield {op: 'char', ch: code[pos + 1 + typed], delay: keyDelay(code[pos + 1 + typed])};
        typed++;
    }
    extra = typed;

    for (let i = 0; i <= extra; i++)
        yield {op: 'back', delay: i === 0 ? between(150, 450) : between(60, 120)};
    yield {op: 'char', ch, delay: between(80, 160)};
    // Стёртые лишние символы вызывающий цикл наберёт заново, начиная с pos + 1.
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isLetter(ch) {
    return ch.toLowerCase() in NEIGHBORS;
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isWordChar(ch) {
    return /[A-Za-z0-9_]/.test(ch);
}
