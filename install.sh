#!/usr/bin/env bash
# Установка dndmod: расширение GNOME Shell, скрипт в ~/.local/bin, man-страница и хоткей.
#
# Использование:
#   ./install.sh                    хоткей по умолчанию <Super><Shift>m
#   ./install.sh '<Control><Alt>d'  свой хоткей

set -eu

readonly SRC="$(cd "$(dirname "$0")" && pwd)"
readonly UUID="dndmod@ovxivan"
readonly BINDING="${1:-<Super><Shift>m}"
readonly TARGET="$HOME/.local/bin/dndmod"
readonly EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
readonly MEDIA="org.gnome.settings-daemon.plugins.media-keys"
readonly PATH_KEY="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/dndmod/"

# Добавляет элемент в строковый массив gsettings, если его там нет.
append_unique() {
    local schema=$1 key=$2 item=$3 list
    list=$(gsettings get "$schema" "$key")
    [[ "$list" == *"'$item'"* ]] && return
    if [[ "$list" == "@as []" || "$list" == "[]" ]]; then
        list="['$item']"
    else
        list="${list%]}, '$item']"
    fi
    gsettings set "$schema" "$key" "$list"
}

install -Dm755 "$SRC/dndmod" "$TARGET"
install -Dm644 "$SRC/dndmod.1" "$HOME/.local/share/man/man1/dndmod.1"
install -Dm644 -t "$EXT_DIR" "$SRC/$UUID/metadata.json" "$SRC/$UUID/extension.js" "$SRC/$UUID/mode.js" "$SRC/$UUID/palette.js" "$SRC/$UUID/palette-cli.js"

append_unique org.gnome.shell enabled-extensions "$UUID"

append_unique "$MEDIA" custom-keybindings "$PATH_KEY"
entry="$MEDIA.custom-keybinding:$PATH_KEY"
gsettings set "$entry" name "dndmod"
gsettings set "$entry" command "$TARGET"
gsettings set "$entry" binding "$BINDING"

echo "Установлено: $TARGET, расширение $UUID, хоткей $BINDING"
echo "Изменения mode.js/palette.js подхватятся при следующем запуске dndmod."
echo "Перезаход в сессию нужен только при первой установке и правке extension.js."
