#include <Security/Security.h>
#include <stdlib.h>

void randombytes(unsigned char *x, unsigned long long xlen) {
  if (xlen == 0) return;
  if (SecRandomCopyBytes(kSecRandomDefault, (size_t)xlen, x) == errSecSuccess) return;
  for (unsigned long long i = 0; i < xlen; i++) {
    x[i] = (unsigned char)arc4random_uniform(256);
  }
}
