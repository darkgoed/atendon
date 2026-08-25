export function formatBrazilianPhone(value: string) {
  const enteredDigits = value.replace(/\D/g, "");
  const nationalDigits = enteredDigits.length > 11 && enteredDigits.startsWith("55")
    ? enteredDigits.slice(2)
    : enteredDigits;
  const digits = nationalDigits.slice(0, 11);
  const areaCode = digits.slice(0, 2);
  const number = digits.slice(2);

  if (digits.length <= 2) return areaCode;
  if (number.length <= 5) return `${areaCode} ${number}`;
  return `${areaCode} ${number.slice(0, 5)}-${number.slice(5)}`;
}

export function isValidBrazilianPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11;
}
