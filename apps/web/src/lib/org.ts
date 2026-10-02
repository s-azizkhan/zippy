import { useOutletContext } from "react-router";
import type { Org } from "@zippy/shared";

export const useOrg = () => useOutletContext<{ org: Org }>().org;
