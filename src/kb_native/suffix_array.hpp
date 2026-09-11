#pragma once
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace kb {

struct Match {
  int block_id;
  int start;
  int end;
  float score;
};

std::vector<int> build_suffix_array(const std::string &text);
std::vector<int> build_lcp(const std::string &text, const std::vector<int> &sa);

// Returns (start, end) half-open range in SA for pattern (exact).
std::pair<int, int> sa_equal_range(const std::string &text, const std::vector<int> &sa,
                                   const std::string &pattern);

std::vector<Match> sa_find(const std::string &text, const std::vector<int> &sa,
                           const std::string &pattern, int max_hits = 1000);

} // namespace kb
