#include <nanobind/nanobind.h>
#include <nanobind/ndarray.h>
#include <nanobind/stl/pair.h>
#include <nanobind/stl/string.h>
#include <nanobind/stl/tuple.h>
#include <nanobind/stl/vector.h>

#include "aho_corasick.hpp"
#include "bm25.hpp"
#include "distance.hpp"
#include "suffix_array.hpp"
#include "trigrams.hpp"
#include "vectors.hpp"

namespace nb = nanobind;

NB_MODULE(kb_native, m) {
  m.doc() = "Knowledge-base native algorithms";

  m.def("build_suffix_array", &kb::build_suffix_array);
  m.def("build_lcp", &kb::build_lcp);
  m.def(
      "sa_find",
      [](const std::string& text, const std::vector<int>& sa, const std::string& pattern,
         int max_hits) {
        auto hits = kb::sa_find(text, sa, pattern, max_hits);
        std::vector<std::tuple<int, int, float>> out;
        out.reserve(hits.size());
        for (auto& h : hits) out.emplace_back(h.start, h.end, h.score);
        return out;
      },
      nb::arg("text"), nb::arg("sa"), nb::arg("pattern"), nb::arg("max_hits") = 1000);

  m.def(
      "build_trigrams",
      [](const std::string& text) {
        auto map = kb::build_trigrams(text);
        // return list of (key, positions)
        std::vector<std::pair<uint32_t, std::vector<int>>> out;
        out.reserve(map.size());
        for (auto& [k, v] : map) out.emplace_back(k, v);
        return out;
      });

  m.def(
      "trigram_candidates",
      [](const std::vector<std::pair<uint32_t, std::vector<int>>>& entries,
         const std::string& pattern, int max_candidates) {
        kb::TrigramMap map;
        for (auto& [k, v] : entries) map[k] = v;
        return kb::trigram_candidates(map, pattern, max_candidates);
      },
      nb::arg("entries"), nb::arg("pattern"), nb::arg("max_candidates") = 200);

  nb::class_<kb::AhoCorasick>(m, "AhoCorasick")
      .def(nb::init<>())
      .def("build", &kb::AhoCorasick::build)
      .def("search", [](const kb::AhoCorasick& self, const std::string& text) {
        auto hits = self.search(text);
        std::vector<std::tuple<int, int, int>> out;
        out.reserve(hits.size());
        for (auto& h : hits) out.emplace_back(h.pattern_id, h.start, h.end);
        return out;
      });

  m.def("damerau_levenshtein", &kb::damerau_levenshtein);
  m.def("normalized_similarity", &kb::normalized_similarity);
  m.def(
      "fuzzy_window_search",
      [](const std::string& text, const std::string& pattern, double min_score, int max_hits,
         const std::vector<int>& candidates) {
        auto hits = kb::fuzzy_window_search(text, pattern, min_score, max_hits, candidates);
        std::vector<std::tuple<int, int, double>> out;
        for (auto& h : hits) out.emplace_back(h.start, h.end, h.score);
        return out;
      },
      nb::arg("text"), nb::arg("pattern"), nb::arg("min_score") = 0.7, nb::arg("max_hits") = 50,
      nb::arg("candidates") = std::vector<int>{});

  m.def(
      "bm25_score",
      [](const std::vector<int>& tfs, const std::vector<float>& idfs, int doc_len, float avgdl,
         float k1, float b) {
        return kb::bm25_score(tfs, idfs, doc_len, avgdl, {k1, b});
      },
      nb::arg("tfs"), nb::arg("idfs"), nb::arg("doc_len"), nb::arg("avgdl"), nb::arg("k1") = 0.9f,
      nb::arg("b") = 0.75f);

  m.def(
      "bm25_batch",
      [](const std::vector<std::vector<int>>& tfs, const std::vector<float>& idfs,
         const std::vector<int>& doc_lens, float avgdl, float k1, float b) {
        return kb::bm25_batch(tfs, idfs, doc_lens, avgdl, {k1, b});
      },
      nb::arg("tfs"), nb::arg("idfs"), nb::arg("doc_lens"), nb::arg("avgdl"), nb::arg("k1") = 0.9f,
      nb::arg("b") = 0.75f);

  m.def(
      "cosine_f32",
      [](nb::ndarray<float, nb::ndim<1>, nb::c_contig> a,
         nb::ndarray<float, nb::ndim<1>, nb::c_contig> b) {
        if (a.shape(0) != b.shape(0)) throw std::invalid_argument("dim mismatch");
        return kb::cosine_f32(a.data(), b.data(), static_cast<int>(a.shape(0)));
      });

  m.def(
      "pack_binary",
      [](nb::ndarray<float, nb::ndim<1>, nb::c_contig> vec) {
        int dim = static_cast<int>(vec.shape(0));
        int nwords = (dim + 63) / 64;
        std::vector<uint64_t> out(nwords);
        kb::pack_binary(vec.data(), dim, out.data());
        return out;
      });

  m.def("hamming_distance", [](const std::vector<uint64_t>& a, const std::vector<uint64_t>& b) {
    if (a.size() != b.size()) throw std::invalid_argument("nwords mismatch");
    return kb::hamming_distance(a.data(), b.data(), static_cast<int>(a.size()));
  });

  m.def(
      "hamming_topk",
      [](nb::ndarray<uint64_t, nb::ndim<2>, nb::c_contig> matrix,
         nb::ndarray<uint64_t, nb::ndim<1>, nb::c_contig> query, int k) {
        int nrows = static_cast<int>(matrix.shape(0));
        int nwords = static_cast<int>(matrix.shape(1));
        if (static_cast<int>(query.shape(0)) != nwords)
          throw std::invalid_argument("query nwords mismatch");
        return kb::hamming_topk(matrix.data(), nrows, nwords, query.data(), k);
      },
      nb::arg("matrix"), nb::arg("query"), nb::arg("k"));

  m.def(
      "rescore_int8",
      [](nb::ndarray<float, nb::ndim<1>, nb::c_contig> query,
         nb::ndarray<int8_t, nb::ndim<2>, nb::c_contig> rows,
         nb::ndarray<float, nb::ndim<1>, nb::c_contig> scales,
         const std::vector<int>& row_ids) {
        int dim = static_cast<int>(query.shape(0));
        if (static_cast<int>(rows.shape(1)) != dim) throw std::invalid_argument("dim mismatch");
        return kb::rescore_int8(query.data(), dim, rows.data(), static_cast<int>(rows.shape(0)),
                                scales.data(), row_ids);
      },
      nb::arg("query"), nb::arg("rows"), nb::arg("scales"), nb::arg("row_ids"));

  m.def(
      "rescore_f16",
      [](nb::ndarray<float, nb::ndim<1>, nb::c_contig> query,
         nb::ndarray<uint16_t, nb::ndim<2>, nb::c_contig> rows, const std::vector<int>& row_ids) {
        int dim = static_cast<int>(query.shape(0));
        if (static_cast<int>(rows.shape(1)) != dim) throw std::invalid_argument("dim mismatch");
        return kb::rescore_f16(query.data(), dim, rows.data(), static_cast<int>(rows.shape(0)),
                               row_ids);
      },
      nb::arg("query"), nb::arg("rows"), nb::arg("row_ids"));

  m.def("coverage", [](const std::string& text, const std::string& pattern) {
    if (pattern.empty()) return 0.0;
    if (text.find(pattern) != std::string::npos) return 1.0;
    // fraction of pattern chars found as subsequence-ish: use similarity
    return kb::normalized_similarity(text, pattern);
  });
}
