#pragma once
#include <cstdint>
#include <utility>
#include <vector>

namespace kb {

float cosine_f16(const uint16_t* a, const uint16_t* b, int dim);
float cosine_f32(const float* a, const float* b, int dim);

// Pack float32 unit vector into uint64 words (sign bits), dim must be multiple of 64 preferably padded.
void pack_binary(const float* vec, int dim, uint64_t* out_words);

int hamming_distance(const uint64_t* a, const uint64_t* b, int nwords);

// Returns (row_index, distance) sorted ascending by distance, length <= k.
std::vector<std::pair<int, int>> hamming_topk(const uint64_t* matrix, int nrows, int nwords,
                                              const uint64_t* query, int k);

// Asymmetric: float32 query @ int8 rows with per-row scale (and optional zero-point=0).
std::vector<float> rescore_int8(const float* query, int dim, const int8_t* rows, int nrows,
                                const float* scales, const std::vector<int>& row_ids);

std::vector<float> rescore_f16(const float* query, int dim, const uint16_t* rows, int nrows,
                               const std::vector<int>& row_ids);

}  // namespace kb
