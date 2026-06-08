import React from "react";
import { AppError } from "@kiln/core";

export function load(): never {
  throw AppError.redirect("/contacts");
}

export default function RootPage() {
  return <></>;
}
