#include "bm25.hpp"

#include <algorithm>
#include <cmath>

namespace kb {

float bm25_score(const std::vector<int> &tfs, const std::vector<float> &idfs, int doc_len,
                 float avgdl, BM25Params params) {
  if (tfs.size() != idfs.size() || avgdl <= 0.f)
    return 0.f;
  float score = 0.f;
  float norm = 1.f - params.b + params.b * (static_cast<float>(doc_len) / avgdl);
  for (size_t i = 0; i < tfs.size(); ++i) {
    float tf = static_cast<float>(tfs[i]);
    if (tf <= 0.f)
      continue;
    float num = tf * (params.k1 + 1.f);
    float den = tf + params.k1 * norm;
    score += idfs[i] * (num / den);
  }
  return score;
}

std::vector<float> bm25_batch(const std::vector<std::vector<int>> &tfs,
                              const std::vector<float> &idfs, const std::vector<int> &doc_lens,
                              float avgdl, BM25Params params) {
  std::vector<float> out;
  out.reserve(tfs.size());
  for (size_t i = 0; i < tfs.size(); ++i) {
    int len = i < doc_lens.size() ? doc_lens[i] : 0;
    out.push_back(bm25_score(tfs[i], idfs, len, avgdl, params));
  }
  return out;
}

} // namespace kb
