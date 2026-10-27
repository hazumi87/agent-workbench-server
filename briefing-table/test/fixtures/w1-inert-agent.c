/* Inert foreground REPL, shaped after basic-scratch-instance's fake Claude.
 * No model, eval, shell, network, credentials, or input interpretation. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <termios.h>
#include <sys/stat.h>
static void q(FILE *f, const char *s) {
  fputc('"', f);
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { fputc('\\', f); fputc(c, f); }
    else if (c < 32) fprintf(f, "\\u%04x", c);
    else fputc(c, f);
  }
  fputc('"', f);
}
static void paint(void) {
  puts("\r\nT1 INERT AGENT READY");
  for (int i = 0; i < 8; i++) puts("Owned inert REPL: input is data only; no model, evaluation or network.");
  puts("  ? for shortcuts");
  fflush(stdout);
}
int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("2.1.0 (inert proof)"); return 0; }
  const char *root = getenv("WB_T1_ROOT"), *pane = getenv("HARBOR_WB_PANEID"), *binary = getenv("WB_T1_BINARY"), *sid = NULL;
  for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--session-id")) sid = argv[i + 1];
  if (!root || !pane || !binary || !sid) return 91;
  char cwd[4096], path[8192];
  if (!getcwd(cwd, sizeof cwd)) return 92;
  snprintf(path, sizeof path, "%s/agents/%ld.json", root, (long)getpid());
  FILE *f = fopen(path, "w"); if (!f) return 93;
  chmod(path, 0600);
  fprintf(f, "{\"pid\":%ld,\"paneid\":", (long)getpid()); q(f, pane);
  fputs(",\"script\":", f); q(f, argv[0]);
  fputs(",\"vendorBinary\":", f); q(f, binary);
  fputs(",\"cwd\":", f); q(f, cwd);
  fputs(",\"sessionId\":", f); q(f, sid); fputs("}\n", f); fclose(f);
  struct termios prior, raw;
  if (tcgetattr(0, &prior) != 0) return 94;
  raw = prior; raw.c_lflag &= ~(ICANON | ECHO); raw.c_cc[VMIN] = 1; raw.c_cc[VTIME] = 0;
  if (tcsetattr(0, TCSANOW, &raw) != 0) return 95;
  /* Real startup output arrives after the process identity is observable. */
  usleep(900000); paint();
  char bytes[4096]; ssize_t count;
  while ((count = read(0, bytes, sizeof bytes)) > 0) {
    if (memchr(bytes, 13, (size_t)count) || memchr(bytes, 10, (size_t)count)) paint();
  }
  tcsetattr(0, TCSANOW, &prior);
  return 0;
}
