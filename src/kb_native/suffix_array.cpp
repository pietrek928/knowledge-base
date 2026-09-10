#include "suffix_array.hpp"

#include <algorithm>
#include <numeric>

namespace kb {

std::vector<int> build_suffix_array(const std::string& text) {
  const int n = static_cast<int>(text.size());
  std::vector<int> sa(n);
  std::iota(sa.begin(), sa.end(), 0);
  std::sort(sa.begin(), sa.end(), [&](int a, int b) {
    return text.compare(a, std::string::npos, text, b, std::string::npos) < 0;
  });
  return sa;
}

std::vector<int> build_lcp(const std::string& text, const std::vector<int>& sa) {
  const int n = static_cast<int>(sa.size());
  std::vector<int> rank(n), lcp(n, 0);
  for (int i = 0; i < n; ++i) rank[sa[i]] = i;
  int k = 0;
  for (int i = 0; i < n; ++i) {
    if (rank[i] == 0) {
      k = 0;
      continue;
    }
    int j = sa[rank[i] - 1];
    while (i + k < n && j + k < n && text[i + k] == text[j + k]) ++k;
    lcp[rank[i]] = k;
    if (k) --k;
  }
  return lcp;
}

std::pair<int, int> sa_equal_range(const std::string& text, const std::vector<int>& sa,
                                   const std::string& pattern) {
  const int n = static_cast<int>(sa.size());
  const int m = static_cast<int>(pattern.size());
  if (m == 0 || n == 0) return {0, 0};

  auto lower = std::lower_bound(sa.begin(), sa.end(), pattern, [&](int pos, const std::string& p) {
    return text.compare(pos, m, p) < 0;
  });
  auto upper = std::upper_bound(sa.begin(), sa.end(), pattern, [&](const std::string& p, int pos) {
    return text.compare(pos, m, p) > 0;
  });
  return {static_cast<int>(lower - sa.begin()), static_cast<int>(upper - sa.begin())};
}

std::vector<Match> sa_find(const std::string& text, const std::vector<int>& sa,
                           const std::string& pattern, int max_hits) {
  auto [lo, hi] = sa_equal_range(text, sa, pattern);
  std::vector<Match> out;
  const int m = static_cast<int>(pattern.size());
  for (int i = lo; i < hi && static_cast<int>(out.size()) < max_hits; ++i) {
    Match mt;
    mt.block_id = -1;
    mt.start = sa[i];
    mt.end = sa[i] + m;
    mt.score = 1.0f;
    out.push_back(mt);
  }
  return out;
}

}  // namespace kb
