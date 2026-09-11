#include "tweetnacl.h"

int nacl_box_keypair(unsigned char *pk, unsigned char *sk);
int nacl_box(
  unsigned char *c,
  const unsigned char *m,
  unsigned long long mlen,
  const unsigned char *n,
  const unsigned char *pk,
  const unsigned char *sk
);
int nacl_box_open(
  unsigned char *m,
  const unsigned char *c,
  unsigned long long clen,
  const unsigned char *n,
  const unsigned char *pk,
  const unsigned char *sk
);
