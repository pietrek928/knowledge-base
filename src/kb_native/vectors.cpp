#include "vectors.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <limits>
#include <queue>

namespace kb {

static inline float f16_to_f32(uint16_t h) {
  uint32_t sign = (h >> 15) & 1;
  uint32_t exp = (h >> 10) & 0x1f;
  uint32_t mant = h & 0x3ff;
  uint32_t bits;
  if (exp == 0) {
    if (mant == 0) {
      bits = sign << 31;
    } else {
      exp = 127 - 15 + 1;
      while ((mant & 0x400) == 0) {
        mant <<= 1;
        --exp;
      }
      mant &= 0x3ff;
      bits = (sign << 31) | (exp << 23) | (mant << 13);
    }
  } else if (exp == 31) {
    bits = (sign << 31) | 0x7f800000u | (mant << 13);
  } else {
    bits = (sign << 31) | ((exp + (127 - 15)) << 23) | (mant << 13);
  }
  float out;
  std::memcpy(&out, &bits, sizeof(out));
  return out;
}

float cosine_f32(const float *a, const float *b, int dim) {
  double dot = 0, na = 0, nb = 0;
  for (int i = 0; i < dim; ++i) {
    double x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na == 0 || nb == 0)
    return 0.f;
  return static_cast<float>(dot / (std::sqrt(na) * std::sqrt(nb)));
}

float cosine_f16(const uint16_t *a, const uint16_t *b, int dim) {
  double dot = 0, na = 0, nb = 0;
  for (int i = 0; i < dim; ++i) {
    double x = f16_to_f32(a[i]), y = f16_to_f32(b[i]);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na == 0 || nb == 0)
    return 0.f;
  return static_cast<float>(dot / (std::sqrt(na) * std::sqrt(nb)));
}

void pack_binary(const float *vec, int dim, uint64_t *out_words) {
  int nwords = (dim + 63) / 64;
  for (int w = 0; w < nwords; ++w) {
    uint64_t word = 0;
    for (int b = 0; b < 64; ++b) {
      int i = w * 64 + b;
      if (i < dim && vec[i] >= 0.f)
        word |= (uint64_t{1} << b);
    }
    out_words[w] = word;
  }
}

int hamming_distance(const uint64_t *a, const uint64_t *b, int nwords) {
  int d = 0;
  for (int i = 0; i < nwords; ++i) {
    d += std::popcount(a[i] ^ b[i]);
  }
  return d;
}

std::vector<std::pair<int, int>> hamming_topk(const uint64_t *matrix, int nrows, int nwords,
                                              const uint64_t *query, int k) {
  using Pair = std::pair<int, int>; // distance, row
  auto cmp = [](const Pair &a, const Pair &b) {
    if (a.first != b.first)
      return a.first < b.first; // max-heap by distance
    return a.second > b.second;
  };
  std::priority_queue<Pair, std::vector<Pair>, decltype(cmp)> heap(cmp);
  for (int r = 0; r < nrows; ++r) {
    int dist = hamming_distance(matrix + static_cast<size_t>(r) * nwords, query, nwords);
    if (static_cast<int>(heap.size()) < k) {
      heap.emplace(dist, r);
    } else if (dist < heap.top().first) {
      heap.pop();
      heap.emplace(dist, r);
    }
  }
  std::vector<Pair> out;
  out.reserve(heap.size());
  while (!heap.empty()) {
    out.emplace_back(heap.top().second, heap.top().first);
    heap.pop();
  }
  std::reverse(out.begin(), out.end());
  return out;
}

std::vector<float> rescore_int8(const float *query, int dim, const int8_t *rows, int nrows,
                                const float *scales, const std::vector<int> &row_ids) {
  std::vector<float> scores;
  scores.reserve(row_ids.size());
  for (int rid : row_ids) {
    if (rid < 0 || rid >= nrows) {
      scores.push_back(0.f);
      continue;
    }
    const int8_t *row = rows + static_cast<size_t>(rid) * dim;
    double acc = 0;
    for (int i = 0; i < dim; ++i)
      acc += static_cast<double>(query[i]) * static_cast<double>(row[i]);
    float scale = scales ? scales[rid] : 1.f;
    scores.push_back(static_cast<float>(acc * scale));
  }
  return scores;
}

std::vector<float> rescore_f16(const float *query, int dim, const uint16_t *rows, int nrows,
                               const std::vector<int> &row_ids) {
  std::vector<float> scores;
  scores.reserve(row_ids.size());
  for (int rid : row_ids) {
    if (rid < 0 || rid >= nrows) {
      scores.push_back(0.f);
      continue;
    }
    const uint16_t *row = rows + static_cast<size_t>(rid) * dim;
    double acc = 0, nq = 0, nr = 0;
    for (int i = 0; i < dim; ++i) {
      double q = query[i];
      double v = f16_to_f32(row[i]);
      acc += q * v;
      nq += q * q;
      nr += v * v;
    }
    if (nq == 0 || nr == 0)
      scores.push_back(0.f);
    else
      scores.push_back(static_cast<float>(acc / (std::sqrt(nq) * std::sqrt(nr))));
  }
  return scores;
}

} // namespace kb
