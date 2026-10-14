class ArUcoTag {
  constructor(id) {
    this.id = id;
  }
  centroidX = 0;
  centroidY = 0;
  widthX = 0;
  heightY = 0;
}

const tagArray = [];

const baseId = Number(document.getElementById("generate_tag_code").value);
const tagCountSlider = document.getElementById("tag_count");

function syncTagArray(count) {
  count = Math.max(0, Math.floor(count));
  while (tagArray.length < count) {
    tagArray.push(new ArUcoTag(baseId + tagArray.length));
  }
  while (tagArray.length > count) {
    tagArray.pop();
  }
}

function onChangeTagCount(event) {
  syncTagArray(Number(event.target.value));
  console.log(tagArray.length);
}

syncTagArray(Number(tagCountSlider.value));
tagCountSlider.addEventListener("input", onChangeTagCount);

export { tagArray };
export default ArUcoTag;
syncTagArray();
