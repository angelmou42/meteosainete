"""Tests de las funciones del análisis (sin descargar nada).

Ejecutar con:  python -m unittest discover analisis
"""

import unittest
from datetime import date

from consenso_ponderado import weighted_median
from verificacion_lluvia import daily_sums, scores


class DailySumsTest(unittest.TestCase):
    # 48 horas: 1 mm cada hora del 1 de marzo (marcas 00:00 … 23:00), nada el 2.
    times = [f"2025-03-0{1 + h // 24}T{h % 24:02d}:00" for h in range(48)]
    values = [1.0] * 24 + [0.0] * 24

    def test_dia_natural(self):
        # El valor con marca 00:00 es la lluvia de las 23 a las 00 del día anterior.
        sums = daily_sums(self.times, self.values, start_hour=0, shift=0)
        self.assertIsNone(sums[date(2025, 2, 28)])          # solo tiene 1 hora: incompleto
        self.assertEqual(sums[date(2025, 3, 1)], 23.0)      # 01:00 … 23:00 con lluvia + las 00:00 del día 2 sin ella

    def test_dia_de_06_a_06(self):
        sums = daily_sums(self.times, self.values, start_hour=6, shift=0)
        # Del 1 de marzo a las 06 al 2 a las 06 UTC: llueve en las marcas 07:00 … 23:00, 17 horas.
        self.assertEqual(sums[date(2025, 3, 1)], 17.0)

    def test_hueco_anula_el_dia(self):
        values = list(self.values)
        values[30] = None
        sums = daily_sums(self.times, values, start_hour=6, shift=0)
        self.assertIsNone(sums[date(2025, 3, 1)])


class ScoresTest(unittest.TestCase):
    def test_tabla_de_contingencia(self):
        d = date(2025, 1, 1)
        # (previsto, medido): 1 acierto de lluvia, 1 falsa alarma, 1 fallo, 1 acierto de seco.
        pairs = [(5, 3, d), (2, 0, d), (0, 4, d), (0, 0, d)]
        s = scores(pairs)
        self.assertEqual(s["acierto"], 50)
        self.assertEqual(s["deteccion"], 50)
        self.assertEqual(s["falsas"], 50)
        self.assertAlmostEqual(s["heidke"], 0)  # 50 % con 50 % de días de lluvia: como el azar

    def test_perfecto(self):
        d = date(2025, 1, 1)
        s = scores([(5, 3, d), (0, 0, d)])
        self.assertEqual(s["heidke"], 1)


class WeightedMedianTest(unittest.TestCase):
    def test_pesos_iguales_es_la_mediana(self):
        self.assertEqual(weighted_median([1, 5, 3], [1, 1, 1]), 3)
        self.assertEqual(weighted_median([1, 2, 3, 4], [1, 1, 1, 1]), 2.5)

    def test_un_peso_grande_manda(self):
        self.assertEqual(weighted_median([1, 5, 3], [1, 10, 1]), 5)


if __name__ == "__main__":
    unittest.main()
