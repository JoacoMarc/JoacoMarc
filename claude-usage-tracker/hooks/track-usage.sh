#!/usr/bin/env bash
# Hook `Stop` de Claude Code — macOS y Linux.
#
# Se cuelga del final de cada turno para mantener el agregado al día sin que tengas que
# acordarte de correr nada.
#
# Tres propiedades que este script tiene que cumplir sí o sí, porque corre en el camino
# crítico de cada turno:
#
#   1. MUDO. No escribe nada a stdout ni a stderr. Los hooks de Stop pueden devolver
#      contenido que se le inyecta al modelo, y eso te costaría tokens en cada turno.
#      Todo lo que tenga para decir va a hooks/track-usage.log.
#   2. EXIT 0 SIEMPRE. Un hook que falla te muestra un error en medio del trabajo.
#   3. NO BLOQUEA. El export es local y tarda milisegundos, pero el push necesita red y
#      se lanza desacoplado: si estás sin conexión, el dato local ya quedó guardado y el
#      push sale la próxima vez.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$REPO/hooks/track-usage.log"

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

  if ! command -v node >/dev/null 2>&1; then
    echo "node no está en el PATH; se omite"
    exit 0
  fi

  node "$REPO/src/export.js" || echo "export falló"

  # Push desacoplado. Sin red, esto falla en silencio y no molesta a nadie.
  if [ "${TRACKER_PUSH:-1}" = "1" ] && [ -d "$REPO/.git" ]; then
    (
      cd "$REPO" || exit 0
      if ! git diff --quiet -- data/ 2>/dev/null; then
        git add data/ >/dev/null 2>&1
        git commit -m "datos: $(hostname) $(date -u +%Y-%m-%dT%H:%MZ)" >/dev/null 2>&1
        git pull --rebase --autostash >/dev/null 2>&1
        git push >/dev/null 2>&1
      fi
    ) &
  fi
} >>"$LOG" 2>&1

exit 0
