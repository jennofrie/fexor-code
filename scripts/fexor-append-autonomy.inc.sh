# Shared by fexor launch-*.sh scripts. Expects:
#   SCRIPT_DIR  — repo root
#   has_arg     — function (needle, argv...)
#   args        — array to append into
# Call: fexor_maybe_append_autonomy "$@"
#
# Disable: FEXOR_AUTONOMY_PROMPT=0  or  FEXOR_DISABLE_AUTONOMY_PROMPT=1
# Override file: FEXOR_AUTONOMY_PROMPT_FILE=/path/to.md
# User --append-system-prompt / --append-system-prompt-file wins.

fexor_maybe_append_autonomy() {
  if has_arg "--append-system-prompt" "$@" || has_arg "--append-system-prompt-file" "$@"; then
    return 0
  fi
  case "${FEXOR_AUTONOMY_PROMPT:-1}" in
    0|false|FALSE|no|NO|off|OFF) return 0 ;;
  esac
  case "${FEXOR_DISABLE_AUTONOMY_PROMPT:-0}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
  esac
  _fexor_autonomy_file="${FEXOR_AUTONOMY_PROMPT_FILE:-$SCRIPT_DIR/prompts/autonomy-system-prompt.md}"
  if [[ -f "$_fexor_autonomy_file" ]]; then
    args+=(--append-system-prompt-file "$_fexor_autonomy_file")
  fi
  unset _fexor_autonomy_file
}
