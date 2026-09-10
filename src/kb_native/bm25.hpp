#pragma once
#include <cstdint>
#include <vector>

namespace kb {

struct BM25Params {
  float k1 = 0.9f;
  float b = 0.75f;
};

float bm25_score(const std::vector<int>& tfs, const std::vector<float>& idfs, int doc_len,
                 float avgdl, BM25Params params);

std::vector<float> bm25_batch(const std::vector<std::vector<int>>& tfs,
                              const std::vector<float>& idfs,
                              const std::vector<int>& doc_lens, float avgdl,
                              BM25Params params);

}  // namespace kb
