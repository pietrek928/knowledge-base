#include "distance.hpp"

#include <algorithm>
#include <cmath>

#include <rapidfuzz/distance/DamerauLevenshtein.hpp>

namespace kb {

double damerau_levenshtein(const std::string& a, const std::string& b) {
  return static_cast<double>(rapidfuzz::experimental::damerau_levenshtein_distance(a, b));
}

double normalized_similarity(const std::string& a, const std::string& b) {
  if (a.empty() && b.empty()) return 1.0;
  return rapidfuzz::experimental::damerau_levenshtein_normalized_similarity(a, b);
}

std::vector<FuzzyHit> fuzzy_window_search(const std::string& text, const std::string& pattern,
                                          double min_score, int max_hits,
                                          const std::vector<int>& candidate_starts) {
  std::vector<FuzzyHit> out;
  if (pattern.empty() || text.empty()) return out;
  const int m = static_cast<int>(pattern.size());
  const int n = static_cast<int>(text.size());
  auto consider = [&](int start) {
    if (start < 0 || start >= n) return;
    int end = std::min(n, start + m + std::max(2, m / 4));
    int win = end - start;
    if (win < std::max(1, m / 2)) return;
    // try a few window lengths around pattern length
    for (int len = std::max(1, m - 2); len <= std::min(win, m + 2); ++len) {
      if (start + len > n) break;
      std::string window = text.substr(start, len);
      double sim = normalized_similarity(window, pattern);
      if (sim >= min_score) {
        FuzzyHit h;
        h.start = start;
        h.end = start + len;
        h.score = sim;
        out.push_back(h);
        break;
      }
    }
  };
  if (!candidate_starts.empty()) {
    for (int s : candidate_starts) consider(s);
  } else {
    int step = std::max(1, m / 3);
    for (int i = 0; i < n; i += step) consider(i);
  }
  std::sort(out.begin(), out.end(), [](const FuzzyHit& a, const FuzzyHit& b) {
    return a.score > b.score;
  });
  if (static_cast<int>(out.size()) > max_hits) out.resize(max_hits);
  return out;
}

}  // namespace kb
